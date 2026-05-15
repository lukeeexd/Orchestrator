import { randomUUID } from 'node:crypto';
import type {
  Agent,
  AgentBudget,
  AgentRole,
  LogLine,
  RedirectAgentRequest,
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

interface AuthSettings {
  apiKey: string;
  oauthToken: string;
  defaultModel: string;
}

function buildEnv(settings: AuthSettings): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (settings.oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = settings.oauthToken;
    delete env.ANTHROPIC_API_KEY;
  } else if (settings.apiKey) {
    env.ANTHROPIC_API_KEY = settings.apiKey;
  }
  return env;
}

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
  settings: AuthSettings,
  controller: AbortController,
  sinks: RunnerSinks,
): Promise<void> {
  const role = ROLES[req.role];
  const env = buildEnv(settings);
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const elapsedTimer = startElapsedTimer(agentId, controller, sinks);

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

    await consumeQuery(agentId, q, controller, effectiveModel, sinks);
  } finally {
    clearInterval(elapsedTimer);
  }
}

/**
 * Continue a done/error agent's SDK session with a new user message.
 * Uses `options.resume = agent.sessionId` so conversation memory + tools
 * + system prompt are all carried over from the original spawn.
 */
export async function redirectAgent(
  req: RedirectAgentRequest,
  sinks: RunnerSinks,
): Promise<{ ok: boolean; error?: string }> {
  const entry = registry.get(req.agentId);
  if (!entry) return { ok: false, error: 'agent not found' };
  const agent = entry.agent;
  if (!agent.sessionId) {
    return {
      ok: false,
      error: 'no SDK session id captured yet — agent never produced a result event',
    };
  }
  if (agent.status === 'running' || agent.status === 'waiting') {
    return {
      ok: false,
      error: 'agent is still running — abort it first',
    };
  }

  // Flip back to running for the redirected turn.
  registry.patch(req.agentId, { status: 'running', statusLabel: 'Running' });
  sinks.onPatch(req.agentId, { status: 'running', statusLabel: 'Running' });

  const controller = new AbortController();
  registry.setController(req.agentId, controller);

  let resolveDone!: () => void;
  const donePromise = new Promise<void>((res) => {
    resolveDone = res;
  });
  completions.set(req.agentId, donePromise);

  runRedirect(req.agentId, req.body, req.attachments, controller, sinks)
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      sinks.onLog(req.agentId, {
        ts: nowTs(),
        kind: 'error',
        msg: `redirect crashed: ${msg}`,
      });
      sinks.onPatch(req.agentId, { status: 'error', statusLabel: 'Crashed' });
    })
    .finally(() => {
      resolveDone();
      setTimeout(() => completions.delete(req.agentId), 60_000);
    });

  return { ok: true };
}

async function runRedirect(
  agentId: string,
  body: string,
  attachments: string[] | undefined,
  controller: AbortController,
  sinks: RunnerSinks,
): Promise<void> {
  const entry = registry.get(agentId);
  if (!entry || !entry.agent.sessionId) return;
  const settings = readSettings();
  const env = buildEnv(settings);
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const elapsedTimer = startElapsedTimer(agentId, controller, sinks);

  try {
    const attachmentBlock =
      attachments && attachments.length > 0 ? inlineAttachments(attachments) : '';
    const prompt = `${attachmentBlock}Continuing task. New instruction:
${body}`;

    sinks.onLog(agentId, {
      ts: nowTs(),
      kind: 'note',
      msg: `Redirected — resuming session ${entry.agent.sessionId}`,
    });

    const q = sdk.query({
      prompt,
      options: {
        cwd: entry.agent.workspace,
        env,
        abortController: controller,
        permissionMode: 'bypassPermissions',
        resume: entry.agent.sessionId,
      },
    });

    await consumeQuery(agentId, q, controller, entry.agent.model, sinks);
  } finally {
    clearInterval(elapsedTimer);
  }
}

function startElapsedTimer(
  agentId: string,
  controller: AbortController,
  sinks: RunnerSinks,
): NodeJS.Timeout {
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
  return elapsedTimer;
}

async function consumeQuery(
  agentId: string,
  q: AsyncIterable<unknown>,
  controller: AbortController,
  model: string,
  sinks: RunnerSinks,
): Promise<void> {
  const entry0 = registry.get(agentId);
  if (!entry0) return;
  // Cumulative tracking — start from the agent's existing totals so
  // a redirect run accumulates onto the original spawn's numbers.
  const baseTokens = entry0.agent.tokens;
  const baseCost = entry0.agent.cost;
  let runInput = 0;
  let runOutput = 0;
  let turn = 0;

  for await (const event of q) {
    if (controller.signal.aborted) break;
    const ev = event as { type: string; session_id?: string; [k: string]: unknown };

    // Capture session_id whenever we see one — needed for Redirect to
    // resume the conversation later.
    if (typeof ev.session_id === 'string') {
      const e = registry.get(agentId);
      if (e && e.agent.sessionId !== ev.session_id) {
        registry.patch(agentId, { sessionId: ev.session_id });
        sinks.onPatch(agentId, { sessionId: ev.session_id });
      }
    }

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
        runInput += turnInput;
        runOutput += turnOutput;
        const totalTokens = baseTokens + runInput + runOutput;
        const totalCost = baseCost + estimateCost(model, runInput, runOutput);

        // Diagnostic note showing per-turn cost and current cap state.
        const entryNow = registry.get(agentId);
        const budgetView = entryNow
          ? `cap ${entryNow.agent.budget.tokens.toLocaleString()}tok / $${entryNow.agent.budget.usd.toFixed(2)} / ${entryNow.agent.budget.seconds}s`
          : 'no budget';
        sinks.onLog(agentId, {
          ts: nowTs(),
          kind: 'note',
          msg: `turn ${turn} · in ${turnInput.toLocaleString()} · out ${turnOutput.toLocaleString()} · cumulative ${totalTokens.toLocaleString()} · $${totalCost.toFixed(4)} · ${budgetView}`,
        });

        registry.patch(agentId, {
          step: `${turn}/?`,
          tokens: totalTokens,
          cost: totalCost,
        });
        sinks.onPatch(agentId, {
          step: `${turn}/?`,
          tokens: totalTokens,
          cost: totalCost,
        });
        // Budget enforcement after each assistant turn — against cumulative.
        const entry = registry.get(agentId);
        const breach = entry
          ? checkBudget(
              entry.agent.budget,
              totalTokens,
              totalCost,
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
        result?: string;
      };
      // result.usage is for THIS run only; combine with base for cumulative.
      const resultRunInput = result.usage?.input_tokens ?? 0;
      const resultRunOutput = result.usage?.output_tokens ?? 0;
      const finalTokens = baseTokens + resultRunInput + resultRunOutput;
      const finalCost = baseCost + (result.total_cost_usd ?? 0);
      if (result.subtype === 'success') {
        sinks.onLog(agentId, {
          ts: nowTs(),
          kind: 'handoff',
          msg: 'Task complete',
        });
        registry.patch(agentId, {
          status: 'done',
          statusLabel: 'Done',
          tokens: finalTokens,
          cost: finalCost,
        });
        sinks.onPatch(agentId, {
          status: 'done',
          statusLabel: 'Done',
          tokens: finalTokens,
          cost: finalCost,
        });
        const entry = registry.get(agentId);
        if (entry && entry.agent.spawnedBy === 'director') {
          const summary = result.result ?? '';
          director.notifyAgentDone(entry.agent.name, summary);
        }
      } else {
        const errMsg = (result.errors ?? [result.subtype]).join(' · ');
        sinks.onLog(agentId, { ts: nowTs(), kind: 'error', msg: errMsg });
        registry.patch(agentId, {
          status: 'error',
          statusLabel: result.subtype,
          tokens: finalTokens,
          cost: finalCost,
        });
        sinks.onPatch(agentId, {
          status: 'error',
          statusLabel: result.subtype,
          tokens: finalTokens,
          cost: finalCost,
        });
      }
    }
  }
}

export { registry };
