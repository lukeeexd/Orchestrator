import { randomUUID } from 'node:crypto';
import type {
  Agent,
  AgentBudget,
  AgentRole,
  LogLine,
  SpawnAgentRequest,
} from '../../shared/types';
import { ROLES } from '../../shared/roles';
import { estimateCost } from '../../shared/rates';
import * as registry from './registry';
import { classify, nowTs } from './classifier';
import { readSettings } from '../settings';
import * as director from '../director/runner';
import * as persistence from '../persistence';
import { inlineAttachments } from '../attachments';

export interface RunnerSinks {
  onAgent: (agent: Agent) => void;
  onLog: (agentId: string, line: LogLine) => void;
  onPatch: (agentId: string, patch: Partial<Agent>) => void;
}

let agentCounter: Record<AgentRole, number> = {
  pm: 0,
  researcher: 0,
  coder: 0,
  qa: 0,
  devops: 0,
};

function nextName(role: AgentRole): string {
  agentCounter = { ...agentCounter, [role]: agentCounter[role] + 1 };
  const n = agentCounter[role].toString().padStart(2, '0');
  return `${role === 'researcher' ? 'research' : role}-${n}`;
}

function elapsed(startedAt: number): string {
  const total = Math.floor((Date.now() - startedAt) / 1000);
  const m = Math.floor(total / 60)
    .toString()
    .padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/**
 * Returns a description of the first budget breach, or null if within limits.
 * A zero limit means "unlimited" (skip that check).
 */
function checkBudget(
  budget: AgentBudget,
  tokens: number,
  cost: number,
  startedAt: number,
): string | null {
  if (budget.usd > 0 && cost > budget.usd) {
    return `cost $${cost.toFixed(2)} exceeds cap $${budget.usd.toFixed(2)}`;
  }
  if (budget.tokens > 0 && tokens > budget.tokens) {
    return `tokens ${tokens.toLocaleString()} exceed cap ${budget.tokens.toLocaleString()}`;
  }
  if (budget.seconds > 0) {
    const sec = (Date.now() - startedAt) / 1000;
    if (sec > budget.seconds) {
      return `wall-clock ${Math.round(sec)}s exceeds cap ${budget.seconds}s`;
    }
  }
  return null;
}

const completions = new Map<string, Promise<void>>();

/**
 * Returns a promise that resolves when the given agent reaches a terminal
 * status (done | error | aborted). Already-completed agents resolve
 * immediately.
 */
export function awaitCompletion(agentId: string): Promise<void> {
  return completions.get(agentId) ?? Promise.resolve();
}

export async function spawnAgent(
  req: SpawnAgentRequest,
  sinks: RunnerSinks,
): Promise<{ agentId: string }> {
  const role = ROLES[req.role];
  const name = nextName(req.role);
  const id = randomUUID();
  const controller = new AbortController();

  // settings.defaultModel overrides each role's hardcoded model — gives
  // the user one knob to flip Opus / Sonnet / Haiku across the whole fleet.
  const baseSettings = readSettings();
  const effectiveModel = baseSettings.defaultModel || role.model;
  const budget: AgentBudget = {
    usd: req.budget?.usd ?? baseSettings.defaultBudgetUsd,
    tokens: req.budget?.tokens ?? baseSettings.defaultBudgetTokens,
    seconds: req.budget?.seconds ?? baseSettings.defaultBudgetSeconds,
  };

  const agent: Agent = {
    id,
    role: req.role,
    roleLabel: role.label,
    name,
    status: 'running',
    statusLabel: 'Running',
    step: '0/?',
    task: req.task,
    tokens: 0,
    cost: 0,
    elapsed: '00:00',
    model: effectiveModel,
    workspace: req.workspace,
    budget,
    spawnedBy: req.spawnedBy ?? 'user',
    log: [],
    startedAt: Date.now(),
  };

  registry.add(agent, controller);
  persistence.saveAgent(agent);
  sinks.onAgent(agent);

  const settings = readSettings();

  let resolveDone!: () => void;
  const donePromise = new Promise<void>((res) => {
    resolveDone = res;
  });
  completions.set(id, donePromise);

  // Fire-and-forget the async run; events stream via sinks.
  run(id, req, req.workspace, settings, controller, sinks)
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      sinks.onLog(id, { ts: nowTs(), kind: 'error', msg: `runner crashed: ${msg}` });
      sinks.onPatch(id, { status: 'error', statusLabel: 'Crashed' });
    })
    .finally(() => {
      resolveDone();
      // Keep the entry in `completions` for a short tail so late awaiters
      // resolve immediately, then drop it. Memory hygiene.
      setTimeout(() => completions.delete(id), 60_000);
    });

  return { agentId: id };
}

async function run(
  agentId: string,
  req: SpawnAgentRequest,
  workdir: string,
  settings: { apiKey: string; oauthToken: string; defaultModel: string },
  controller: AbortController,
  sinks: RunnerSinks,
): Promise<void> {
  const role = ROLES[req.role];

  // Auth resolution, in order of precedence:
  // 1. Explicit OAuth token from settings → CLAUDE_CODE_OAUTH_TOKEN
  // 2. Explicit API key from settings → ANTHROPIC_API_KEY
  // 3. Nothing — fall through to the SDK's auto-discovery from ~/.claude
  //    (works if you're already logged in via Claude Code CLI)
  const env: Record<string, string | undefined> = { ...process.env };
  if (settings.oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = settings.oauthToken;
    delete env.ANTHROPIC_API_KEY;
  } else if (settings.apiKey) {
    env.ANTHROPIC_API_KEY = settings.apiKey;
  }

  // SDK is ESM-only — load it dynamically from our CJS context.
  const sdk = await import('@anthropic-ai/claude-agent-sdk');

  const elapsedTimer = setInterval(() => {
    const e = registry.get(agentId);
    if (!e) {
      clearInterval(elapsedTimer);
      return;
    }
    const next = elapsed(e.agent.startedAt);
    if (next !== e.agent.elapsed) {
      registry.patch(agentId, { elapsed: next });
      sinks.onPatch(agentId, { elapsed: next });
    }
    // Wall-clock budget can trip even while the API call is in flight,
    // so check it on the elapsed tick too, not just after assistant turns.
    if (
      e.agent.status === 'running' &&
      e.agent.budget.seconds > 0 &&
      (Date.now() - e.agent.startedAt) / 1000 > e.agent.budget.seconds
    ) {
      sinks.onLog(agentId, {
        ts: nowTs(),
        kind: 'error',
        msg: `Wall-clock budget ${e.agent.budget.seconds}s exceeded. Aborting.`,
      });
      controller.abort();
      registry.patch(agentId, {
        status: 'error',
        statusLabel: 'Budget exceeded',
      });
      sinks.onPatch(agentId, {
        status: 'error',
        statusLabel: 'Budget exceeded',
      });
    }
  }, 1000);

  try {
    const effectiveModel = settings.defaultModel || role.model;
    const attachmentBlock =
      req.attachments && req.attachments.length > 0
        ? inlineAttachments(req.attachments)
        : '';
    const promptWithContext = `[workspace] ${workdir}
All file paths resolve here — your Read, Write, Edit, Glob, Grep tools all operate inside this folder. Use simple relative paths like "notes.md" (preferred) or the absolute path above.

Do NOT invent paths like /home/user/, /tmp/, or POSIX-style locations — they are not real on this system. Your bash 'pwd' may report this folder in MSYS form (e.g. /d/ClaudeCode/foo) which is equivalent to the Windows path above; file-tool calls should still use Windows-style or simple relative paths.

${attachmentBlock}Task:
${req.task}`;

    const q = sdk.query({
      prompt: promptWithContext,
      options: {
        cwd: workdir,
        env,
        abortController: controller,
        permissionMode: 'bypassPermissions',
        agent: 'main',
        agents: {
          main: {
            description: `${role.label} for the Orchestrator app`,
            prompt: role.systemPrompt,
            tools: role.tools,
            model: effectiveModel,
          },
        },
      },
    });

    let turn = 0;
    let cumulativeInput = 0;
    let cumulativeOutput = 0;
    for await (const event of q) {
      if (controller.signal.aborted) break;
      const ev = event as { type: string; [k: string]: unknown };

      const lines = classify(ev);
      for (const line of lines) {
        const entry = registry.get(agentId);
        if (entry) entry.agent.log.push(line);
        persistence.appendLogLine(agentId, line);
        sinks.onLog(agentId, line);
      }

      if (ev.type === 'assistant') {
        turn += 1;
        const msg = (ev as { message?: { usage?: Record<string, number | null | undefined> } }).message;
        if (msg?.usage) {
          const u = msg.usage;
          const turnInput =
            (Number(u.input_tokens) || 0) +
            (Number(u.cache_creation_input_tokens) || 0) +
            (Number(u.cache_read_input_tokens) || 0);
          const turnOutput = Number(u.output_tokens) || 0;
          cumulativeInput += turnInput;
          cumulativeOutput += turnOutput;
          const liveTokens = cumulativeInput + cumulativeOutput;
          const liveCost = estimateCost(
            effectiveModel,
            cumulativeInput,
            cumulativeOutput,
          );

          // Diagnostic note so we can see exactly what each turn cost +
          // whether the budget check is reading the right numbers.
          const entryNow = registry.get(agentId);
          const budgetView = entryNow
            ? `cap ${entryNow.agent.budget.tokens.toLocaleString()}tok / $${entryNow.agent.budget.usd.toFixed(2)} / ${entryNow.agent.budget.seconds}s`
            : 'no budget';
          sinks.onLog(agentId, {
            ts: nowTs(),
            kind: 'note',
            msg: `turn ${turn} · in ${turnInput.toLocaleString()} · out ${turnOutput.toLocaleString()} · total ${liveTokens.toLocaleString()} · $${liveCost.toFixed(4)} · ${budgetView}`,
          });

          registry.patch(agentId, {
            step: `${turn}/?`,
            tokens: liveTokens,
            cost: liveCost,
          });
          sinks.onPatch(agentId, {
            step: `${turn}/?`,
            tokens: liveTokens,
            cost: liveCost,
          });
          // Budget enforcement after each assistant turn.
          const entry = registry.get(agentId);
          const breach = entry
            ? checkBudget(
                entry.agent.budget,
                liveTokens,
                liveCost,
                entry.agent.startedAt,
              )
            : null;
          if (breach) {
            sinks.onLog(agentId, {
              ts: nowTs(),
              kind: 'error',
              msg: `Budget exceeded — ${breach}. Aborting.`,
            });
            controller.abort();
            registry.patch(agentId, {
              status: 'error',
              statusLabel: 'Budget exceeded',
            });
            sinks.onPatch(agentId, {
              status: 'error',
              statusLabel: 'Budget exceeded',
            });
            break;
          }
        } else {
          registry.patch(agentId, { step: `${turn}/?` });
          sinks.onPatch(agentId, { step: `${turn}/?` });
        }
      } else if (ev.type === 'result') {
        const result = ev as unknown as {
          subtype: string;
          total_cost_usd?: number;
          usage?: { input_tokens?: number; output_tokens?: number };
          is_error?: boolean;
          errors?: string[];
        };
        const tokens =
          (result.usage?.input_tokens ?? 0) + (result.usage?.output_tokens ?? 0);
        const cost = result.total_cost_usd ?? 0;
        if (result.subtype === 'success') {
          sinks.onLog(agentId, {
            ts: nowTs(),
            kind: 'handoff',
            msg: 'Task complete',
          });
          registry.patch(agentId, {
            status: 'done',
            statusLabel: 'Done',
            tokens,
            cost,
          });
          sinks.onPatch(agentId, {
            status: 'done',
            statusLabel: 'Done',
            tokens,
            cost,
          });
          const entry = registry.get(agentId);
          if (entry && entry.agent.spawnedBy === 'director') {
            const summary =
              (result as unknown as { result?: string }).result ?? '';
            director.notifyAgentDone(entry.agent.name, summary);
          }
        } else {
          const errMsg = (result.errors ?? [result.subtype]).join(' · ');
          sinks.onLog(agentId, { ts: nowTs(), kind: 'error', msg: errMsg });
          registry.patch(agentId, {
            status: 'error',
            statusLabel: result.subtype,
            tokens,
            cost,
          });
          sinks.onPatch(agentId, {
            status: 'error',
            statusLabel: result.subtype,
            tokens,
            cost,
          });
        }
      }
    }
  } finally {
    clearInterval(elapsedTimer);
  }
}

export { registry };
