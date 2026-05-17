import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { app } from 'electron';
import type {
  DirectorMessage,
  DirectorMode,
  EffortLevel,
  PlanRow,
} from '../../shared/types';
import { DEFAULT_EFFORT } from '../../shared/efforts';
import { resolveModel } from '../../shared/models';
import { runClaudeQuery } from '../cli/spawn';
import { runCodexQuery } from '../cli/codex';
import { readSettings } from '../settings';
import { DIRECTOR_SYSTEM_PROMPT } from './prompt';
import { extractDirectives } from './parse';
import { nowTs } from '../agents/classifier';
import * as persistence from '../persistence';
import { inlineAttachments } from '../attachments';
import * as registry from '../agents/registry';
import { getProject } from '../projects';

export interface DirectorSinks {
  onMessage: (projectId: string, msg: DirectorMessage) => void;
  onPatch: (projectId: string, id: string, patch: Partial<DirectorMessage>) => void;
}

type QueueEntry =
  | { kind: 'user'; body: string; mode: DirectorMode; attachments?: string[] }
  | { kind: 'system'; body: string; mode: DirectorMode };

let sharedSinks: DirectorSinks | null = null;

function timeOnly(): string {
  return nowTs().slice(0, 8);
}

/**
 * One Director conversation per project. Keeps its own queue / busy flag /
 * SDK session id so multiple projects can run their Directors in parallel
 * without interfering.
 */
class DirectorSession {
  readonly projectId: string;
  messages: DirectorMessage[] = [];
  private queue: QueueEntry[] = [];
  private busy = false;
  private sessionId: string | null = null;
  private controller: AbortController | null = null;
  private currentMode: DirectorMode = 'auto';

  constructor(projectId: string) {
    this.projectId = projectId;
  }

  hydrate(): void {
    this.messages = persistence.loadDirectorMessages(this.projectId);
    this.sessionId = persistence.loadDirectorSessionId(this.projectId);
  }

  list(): DirectorMessage[] {
    return [...this.messages];
  }

  abort(): void {
    this.controller?.abort();
  }

  private pushMessage(msg: DirectorMessage): void {
    this.messages.push(msg);
    persistence.saveDirectorMessage(msg);
    sharedSinks?.onMessage(this.projectId, msg);
  }

  private patchMessage(id: string, patch: Partial<DirectorMessage>): void {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx >= 0) this.messages[idx] = { ...this.messages[idx], ...patch };
    persistence.patchDirectorMessage(id, patch);
    sharedSinks?.onPatch(this.projectId, id, patch);
  }

  sendFromUser(
    body: string,
    mode: DirectorMode,
    attachments?: string[],
  ): void {
    this.currentMode = mode;
    this.pushMessage({
      id: randomUUID(),
      projectId: this.projectId,
      who: 'user',
      name: 'you',
      time: timeOnly(),
      body,
      attachments:
        attachments && attachments.length > 0
          ? attachments.map((p) => ({ path: p, name: path.basename(p) }))
          : undefined,
    });
    this.queue.push({ kind: 'user', body, mode, attachments });
    void this.pump();
  }

  notifyAgentDone(agentName: string, summary: string): void {
    const body = `[handoff] Agent ${agentName} completed. ${
      summary ? 'Summary: ' + summary : 'No summary.'
    }`;
    this.pushMessage({
      id: randomUUID(),
      projectId: this.projectId,
      who: 'system',
      name: 'system',
      time: timeOnly(),
      body: `${agentName} → done`,
    });
    this.queue.push({ kind: 'system', body, mode: this.currentMode });
    void this.pump();
  }

  acknowledgePlanAccepted(rows: PlanRow[], spawnedNames: string[]): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].plan) {
        this.patchMessage(this.messages[i].id, { planAccepted: true });
        break;
      }
    }
    this.pushMessage({
      id: randomUUID(),
      projectId: this.projectId,
      who: 'system',
      name: 'system',
      time: timeOnly(),
      body: `Spawned ${rows.length} agent${rows.length === 1 ? '' : 's'} · ${spawnedNames.join(' · ')}`,
    });
    const lines = rows
      .map((r) => `  ${r.i}. ${r.role} ${r.name} — ${r.task}`)
      .join('\n');
    this.queue.push({
      kind: 'system',
      body: `Plan accepted. Spawned agents:\n${lines}\n\nReply with "ok" or any additional guidance.`,
      mode: this.currentMode,
    });
    void this.pump();
  }

  acknowledgeRedirect(
    messageId: string,
    agentName: string,
    ok: boolean,
    errorMsg?: string,
  ): void {
    this.patchMessage(messageId, { redirectFired: true });
    if (ok) {
      this.pushMessage({
        id: randomUUID(),
        projectId: this.projectId,
        who: 'system',
        name: 'system',
        time: timeOnly(),
        body: `Redirected ${agentName}`,
      });
      this.queue.push({
        kind: 'system',
        body: `Redirect to @${agentName} fired. The agent is now resuming its session with the new instruction. Reply with "ok" or any additional guidance.`,
        mode: this.currentMode,
      });
    } else {
      this.pushMessage({
        id: randomUUID(),
        projectId: this.projectId,
        who: 'system',
        name: 'system',
        time: timeOnly(),
        body: `Redirect to ${agentName} failed: ${errorMsg ?? 'unknown error'}`,
      });
      this.queue.push({
        kind: 'system',
        body: `Redirect to @${agentName} failed: ${errorMsg ?? 'unknown error'}. Reconsider whether to spawn a fresh agent instead.`,
        mode: this.currentMode,
      });
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (!next) break;
        const attachments = next.kind === 'user' ? next.attachments : undefined;
        await this.runTurn(next.body, next.mode, attachments);
      }
    } finally {
      this.busy = false;
    }
  }

  private buildFleetBlock(): string {
    const all = registry.listForProject(this.projectId);
    if (all.length === 0) return '';
    const lines = all.map((a) => {
      const task = a.task
        ? `, task: "${a.task.slice(0, 80).replace(/"/g, "'")}"`
        : '';
      const tokens =
        a.tokens > 0 ? `, ${(a.tokens / 1000).toFixed(1)}k tok` : '';
      return `- @${a.name} (${a.role}, ${a.status}${task}${tokens})`;
    });
    return `[currently spawned agents]\n${lines.join('\n')}\n[/currently spawned agents]\n\n`;
  }

  private async runTurn(
    promptBody: string,
    mode: DirectorMode,
    attachments?: string[],
  ): Promise<void> {
    const settings = readSettings();
    const env: Record<string, string | undefined> = { ...process.env };
    if (settings.oauthToken) {
      env.CLAUDE_CODE_OAUTH_TOKEN = settings.oauthToken;
      delete env.ANTHROPIC_API_KEY;
    } else if (settings.apiKey) {
      env.ANTHROPIC_API_KEY = settings.apiKey;
    }

    this.controller = new AbortController();

    const directorMessage: DirectorMessage = {
      id: randomUUID(),
      projectId: this.projectId,
      who: 'director',
      name: 'director',
      time: timeOnly(),
      body: '',
      live: true,
    };
    this.pushMessage(directorMessage);

    // Per-project Director model + effort win over the global Director
    // defaults, which are separate from the agent defaults — the Director
    // gets a heavier model out of the box.
    const project = getProject(this.projectId);
    const directorModel =
      project?.directorModel ||
      settings.defaultDirectorModel ||
      settings.defaultModel ||
      'claude-opus-4-7-1m';
    const directorEffort: EffortLevel =
      project?.directorEffort ||
      settings.defaultDirectorEffort ||
      settings.defaultEffort ||
      DEFAULT_EFFORT;
    const resolved = resolveModel(directorModel);

    try {
      const attachmentBlock =
        attachments && attachments.length > 0
          ? inlineAttachments(attachments)
          : '';
      const agentBlock = this.buildFleetBlock();
      const fullPrompt = `[mode: ${mode}]\n${agentBlock}${attachmentBlock}${promptBody}`;
      const provider = project?.provider ?? 'claude';

      const q =
        provider === 'codex'
          ? runCodexQuery({
              cwd: app.getPath('userData'),
              env,
              // Codex has no inline system-prompt knob; prepend the
              // Director instructions as a preamble. The model still
              // needs to follow the orchestrator-plan fenced-JSON
              // convention from DIRECTOR_SYSTEM_PROMPT for plan parsing
              // to work — Codex models are generally OK at this but
              // less reliable than Claude.
              prompt: `[director-role]\n${DIRECTOR_SYSTEM_PROMPT}\n\n---\n\n${fullPrompt}`,
              model: directorModel,
              effort: directorEffort,
              resume: this.sessionId ?? undefined,
              abortController: this.controller,
            })
          : runClaudeQuery({
              cwd: app.getPath('userData'),
              env,
              prompt: fullPrompt,
              abortController: this.controller,
              agent: 'director',
              agents: {
                director: {
                  description: 'Orchestrator director — plans and supervises agents.',
                  prompt: DIRECTOR_SYSTEM_PROMPT,
                  tools: [] as string[],
                  model: resolved.model,
                  effort: directorEffort,
                },
              },
              ...(this.sessionId ? { resume: this.sessionId } : {}),
              betas: resolved.betas,
            });

      let bodyBuf = '';
      for await (const event of q) {
        if (this.controller.signal.aborted) break;
        const ev = event as { type: string; [k: string]: unknown };
        if (ev.type === 'assistant') {
          const message = ev.message as { content?: unknown[] } | undefined;
          const blocks = message?.content ?? [];
          for (const raw of blocks) {
            if (raw == null || typeof raw !== 'object' || !('type' in raw))
              continue;
            const block = raw as { type: string; text?: string };
            if (block.type === 'text' && typeof block.text === 'string') {
              bodyBuf += block.text;
            }
          }
        } else if (ev.type === 'result') {
          const result = ev as unknown as { session_id?: string };
          if (result.session_id) {
            this.sessionId = result.session_id;
            persistence.saveDirectorSessionId(this.projectId, result.session_id);
          }
        }
      }

      const { text, plan, redirect } = extractDirectives(bodyBuf);
      this.patchMessage(directorMessage.id, {
        body: text || (plan || redirect ? '' : '(empty response)'),
        plan: plan ?? undefined,
        redirect: redirect ?? undefined,
        live: false,
      });
    } catch (e) {
      this.patchMessage(directorMessage.id, {
        body: `Error: ${e instanceof Error ? e.message : String(e)}`,
        live: false,
      });
    }
  }
}

const sessions = new Map<string, DirectorSession>();

function getSession(projectId: string): DirectorSession {
  let s = sessions.get(projectId);
  if (!s) {
    s = new DirectorSession(projectId);
    s.hydrate();
    sessions.set(projectId, s);
  }
  return s;
}

export function setSinks(s: DirectorSinks): void {
  sharedSinks = s;
}

/** Hydrate every project's Director session at app startup. */
export function hydrateAll(projectIds: string[]): void {
  for (const id of projectIds) getSession(id);
}

export function discardSession(projectId: string): void {
  sessions.get(projectId)?.abort();
  sessions.delete(projectId);
}

/**
 * Wipe a project's Director chat: abort any live turn, drop the in-memory
 * session, delete persisted messages + the saved SDK session id from disk.
 * The next sendFromUser lazily re-creates an empty session.
 *
 * Use this when the user wants a clean slate without deleting the project
 * itself (which would also drop agents and per-project config).
 */
export function wipeSession(projectId: string): void {
  sessions.get(projectId)?.abort();
  sessions.delete(projectId);
  persistence.wipeDirector(projectId);
}

export function listMessages(projectId: string): DirectorMessage[] {
  return getSession(projectId).list();
}

export function sendFromUser(
  projectId: string,
  body: string,
  mode: DirectorMode,
  attachments?: string[],
): void {
  getSession(projectId).sendFromUser(body, mode, attachments);
}

export function notifyAgentDone(
  projectId: string,
  agentName: string,
  summary: string,
): void {
  getSession(projectId).notifyAgentDone(agentName, summary);
}

export function acknowledgePlanAccepted(
  projectId: string,
  rows: PlanRow[],
  spawnedNames: string[],
): void {
  getSession(projectId).acknowledgePlanAccepted(rows, spawnedNames);
}

export function acknowledgeRedirect(
  projectId: string,
  messageId: string,
  agentName: string,
  ok: boolean,
  errorMsg?: string,
): void {
  getSession(projectId).acknowledgeRedirect(messageId, agentName, ok, errorMsg);
}

export function abort(projectId: string): void {
  sessions.get(projectId)?.abort();
}
