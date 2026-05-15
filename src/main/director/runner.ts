import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import type { DirectorMessage, DirectorMode, PlanRow } from '../../shared/types';
import { readSettings } from '../settings';
import { DIRECTOR_SYSTEM_PROMPT } from './prompt';
import { extractPlan } from './parse';
import { nowTs } from '../agents/classifier';
import * as persistence from '../persistence';

export interface DirectorSinks {
  onMessage: (msg: DirectorMessage) => void;
  onPatch: (id: string, patch: Partial<DirectorMessage>) => void;
}

type QueueEntry =
  | { kind: 'user'; body: string; mode: DirectorMode }
  | { kind: 'system'; body: string; mode: DirectorMode };

const messages: DirectorMessage[] = [];
const queue: QueueEntry[] = [];
let busy = false;
let sessionId: string | null = null;
let controller: AbortController | null = null;
let sinks: DirectorSinks | null = null;

function timeOnly(): string {
  return nowTs().slice(0, 8);
}

function pushMessage(msg: DirectorMessage): void {
  messages.push(msg);
  persistence.saveDirectorMessage(msg);
  sinks?.onMessage(msg);
}

function patchMessage(id: string, patch: Partial<DirectorMessage>): void {
  const idx = messages.findIndex((m) => m.id === id);
  if (idx >= 0) messages[idx] = { ...messages[idx], ...patch };
  persistence.patchDirectorMessage(id, patch);
  sinks?.onPatch(id, patch);
}

export function listMessages(): DirectorMessage[] {
  return [...messages];
}

export function setSinks(s: DirectorSinks): void {
  sinks = s;
}

/**
 * Hydrate Director state from SQLite. Call once at app startup after
 * openDb() but before registerIpcHandlers(), so when the renderer asks
 * for the initial message list it sees the restored chat.
 */
export function hydrate(): void {
  const stored = persistence.loadDirectorMessages();
  messages.length = 0;
  for (const m of stored) messages.push(m);
  sessionId = persistence.loadDirectorSessionId();
}

let currentMode: DirectorMode = 'auto';

export function sendFromUser(body: string, mode: DirectorMode): void {
  currentMode = mode;
  pushMessage({
    id: randomUUID(),
    who: 'user',
    name: 'you',
    time: timeOnly(),
    body,
  });
  queue.push({ kind: 'user', body, mode });
  void pump();
}

export function notifyAgentDone(agentName: string, summary: string): void {
  const body = `[handoff] Agent ${agentName} completed. ${
    summary ? 'Summary: ' + summary : 'No summary.'
  }`;
  pushMessage({
    id: randomUUID(),
    who: 'system',
    name: 'system',
    time: timeOnly(),
    body: `${agentName} → done`,
  });
  // Don't render the raw handoff text in chat — render the short system msg
  // above for the user, and queue the longer text as the actual prompt to
  // the Director session.
  queue.push({ kind: 'system', body, mode: currentMode });
  void pump();
}

export function abort(): void {
  controller?.abort();
}

async function pump(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      await runTurn(next.body, next.mode);
    }
  } finally {
    busy = false;
  }
}

async function runTurn(promptBody: string, mode: DirectorMode): Promise<void> {
  const settings = readSettings();
  const env: Record<string, string | undefined> = { ...process.env };
  if (settings.oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = settings.oauthToken;
    delete env.ANTHROPIC_API_KEY;
  } else if (settings.apiKey) {
    env.ANTHROPIC_API_KEY = settings.apiKey;
  }

  controller = new AbortController();
  const sdk = await import('@anthropic-ai/claude-agent-sdk');

  const directorMessage: DirectorMessage = {
    id: randomUUID(),
    who: 'director',
    name: 'director',
    time: timeOnly(),
    body: '',
    live: true,
  };
  pushMessage(directorMessage);

  const queryOptions = {
    cwd: app.getPath('userData'),
    env,
    abortController: controller,
    permissionMode: 'bypassPermissions' as const,
    agent: 'director',
    agents: {
      director: {
        description: 'Orchestrator director — plans and supervises agents.',
        prompt: DIRECTOR_SYSTEM_PROMPT,
        tools: [] as string[],
        model: settings.defaultModel || 'claude-sonnet-4-6',
      },
    },
    ...(sessionId ? { resume: sessionId } : {}),
  };

  try {
    const q = sdk.query({
      prompt: `[mode: ${mode}] ${promptBody}`,
      options: queryOptions,
    });

    let bodyBuf = '';
    for await (const event of q) {
      if (controller.signal.aborted) break;
      const ev = event as { type: string; [k: string]: unknown };

      if (ev.type === 'assistant') {
        const message = ev.message as { content?: unknown[] } | undefined;
        const blocks = message?.content ?? [];
        for (const raw of blocks) {
          if (raw == null || typeof raw !== 'object' || !('type' in raw)) continue;
          const block = raw as { type: string; text?: string };
          if (block.type === 'text' && typeof block.text === 'string') {
            bodyBuf += block.text;
          }
        }
      } else if (ev.type === 'result') {
        const result = ev as unknown as { session_id?: string };
        if (result.session_id) {
          sessionId = result.session_id;
          persistence.saveDirectorSessionId(result.session_id);
        }
      }
    }

    const { text, plan } = extractPlan(bodyBuf);
    patchMessage(directorMessage.id, {
      body: text || (plan ? '' : '(empty response)'),
      plan: plan ?? undefined,
      live: false,
    });
  } catch (e) {
    patchMessage(directorMessage.id, {
      body: `Error: ${e instanceof Error ? e.message : String(e)}`,
      live: false,
    });
  }
}

/**
 * Synthesize the "plan accepted" follow-up message sent back to the Director
 * after the user clicks Accept and the agents have been spawned.
 */
export function acknowledgePlanAccepted(
  rows: PlanRow[],
  spawnedNames: string[],
): void {
  // Mark the most recent message that has a plan as accepted (for UI)
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].plan) {
      patchMessage(messages[i].id, { planAccepted: true });
      break;
    }
  }
  // Tell the user the spawns happened
  pushMessage({
    id: randomUUID(),
    who: 'system',
    name: 'system',
    time: timeOnly(),
    body: `Spawned ${rows.length} agent${rows.length === 1 ? '' : 's'} · ${spawnedNames.join(' · ')}`,
  });
  // And tell the Director, so its next turn supervises
  const lines = rows.map((r) => `  ${r.i}. ${r.role} ${r.name} — ${r.task}`).join('\n');
  queue.push({
    kind: 'system',
    body: `Plan accepted. Spawned agents:\n${lines}\n\nReply with "ok" or any additional guidance.`,
    mode: currentMode,
  });
  void pump();
}
