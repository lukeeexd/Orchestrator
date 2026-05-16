import { randomUUID } from 'node:crypto';
import type {
  Agent,
  AgentBudget,
  AgentRole,
  EffortLevel,
  ForkAgentRequest,
  LogLine,
  RedirectAgentRequest,
  SpawnAgentRequest,
} from '../../shared/types';
import { ROLES } from '../../shared/roles';
import { DEFAULT_EFFORT } from '../../shared/efforts';
import { resolveModel } from '../../shared/models';
import { estimateCost } from '../../shared/rates';
import * as registry from './registry';
import { classify, nowTs } from './classifier';
import { readSettings } from '../settings';
import * as director from '../director/runner';
import * as persistence from '../persistence';
import { inlineAttachments } from '../attachments';
import { getProject } from '../projects';
import { runClaudeQuery } from '../cli/spawn';

/**
 * Resolve the tool allow-list for an agent: per-project role override
 * (if any) wins over the role's hardcoded default. Used by both initial
 * spawn and fork; redirects already inherit their parent's allow-list
 * via the registry's stored agent definition, so they pass through
 * unchanged.
 */
function resolveTools(role: AgentRole, projectId: string): string[] {
  const project = getProject(projectId);
  const override = project?.roleTools?.[role];
  return override && override.length > 0 ? override : ROLES[role].tools;
}

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

function nextName(role: AgentRole, projectId: string): string {
  const prefix = role === 'researcher' ? 'research' : role;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const a of registry.listForProject(projectId)) {
    const m = a.name.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  const n = (max + 1).toString().padStart(2, '0');
  return `${prefix}-${n}`;
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
  const name = nextName(req.role, req.projectId);
  const id = randomUUID();
  const controller = new AbortController();

  // Cascade per-spawn → settings → role/SDK default for model + effort.
  // Lets users pick both per agent without editing global settings.
  const baseSettings = readSettings();
  const effectiveModel =
    req.model || baseSettings.defaultModel || role.model;
  const effectiveEffort: EffortLevel =
    req.effort || baseSettings.defaultEffort || DEFAULT_EFFORT;
  const budget: AgentBudget = {
    usd: req.budget?.usd ?? baseSettings.defaultBudgetUsd,
    tokens: req.budget?.tokens ?? baseSettings.defaultBudgetTokens,
    seconds: req.budget?.seconds ?? baseSettings.defaultBudgetSeconds,
  };

  const agent: Agent = {
    id,
    projectId: req.projectId,
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
    effort: effectiveEffort,
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

/**
 * Branch a new agent off an existing one's conversation. Uses the SDK's
 * `resume: parent.sessionId, forkSession: true` combo so the fork starts
 * with the parent's full chat history but writes to a fresh session id —
 * the parent stays intact and untouched.
 */
export async function forkAgent(
  req: ForkAgentRequest,
  sinks: RunnerSinks,
): Promise<{ ok: boolean; agentId?: string; error?: string }> {
  const parent = registry.get(req.parentAgentId);
  if (!parent) return { ok: false, error: 'parent agent not found' };
  if (!parent.agent.sessionId) {
    return {
      ok: false,
      error: 'parent has no SDK session id yet — wait for its first result event',
    };
  }

  const role = ROLES[parent.agent.role];
  const name = nextName(parent.agent.role, parent.agent.projectId);
  const id = randomUUID();
  const controller = new AbortController();

  // Fork inherits from the parent, but per-fork overrides win. Budget
  // resets to a fresh allowance (mirroring spawn defaults) — the fork
  // gets its own caps so it doesn't trip the parent's nearly-spent ones.
  const baseSettings = readSettings();
  const effectiveModel = req.model || parent.agent.model;
  const effectiveEffort: EffortLevel = req.effort || parent.agent.effort;

  const agent: Agent = {
    id,
    projectId: parent.agent.projectId,
    role: parent.agent.role,
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
    effort: effectiveEffort,
    workspace: parent.agent.workspace,
    budget: {
      usd: baseSettings.defaultBudgetUsd,
      tokens: baseSettings.defaultBudgetTokens,
      seconds: baseSettings.defaultBudgetSeconds,
    },
    spawnedBy: 'user',
    log: [],
    startedAt: Date.now(),
    forkedFromId: parent.agent.id,
    forkedFromName: parent.agent.name,
  };

  registry.add(agent, controller);
  persistence.saveAgent(agent);
  sinks.onAgent(agent);

  let resolveDone!: () => void;
  const donePromise = new Promise<void>((res) => {
    resolveDone = res;
  });
  completions.set(id, donePromise);

  runFork(
    id,
    parent.agent.sessionId,
    req.task,
    req.attachments,
    controller,
    sinks,
  )
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      sinks.onLog(id, {
        ts: nowTs(),
        kind: 'error',
        msg: `fork crashed: ${msg}`,
      });
      sinks.onPatch(id, { status: 'error', statusLabel: 'Crashed' });
    })
    .finally(() => {
      resolveDone();
      setTimeout(() => completions.delete(id), 60_000);
    });

  return { ok: true, agentId: id };
}

async function runFork(
  agentId: string,
  parentSessionId: string,
  task: string,
  attachments: string[] | undefined,
  controller: AbortController,
  sinks: RunnerSinks,
): Promise<void> {
  const entry = registry.get(agentId);
  if (!entry) return;
  const settings = readSettings();
  const env = buildEnv(settings);
  const elapsedTimer = startElapsedTimer(agentId, controller, sinks);

  try {
    const role = ROLES[entry.agent.role];
    const effectiveModel = entry.agent.model;
    const effectiveEffort = entry.agent.effort || DEFAULT_EFFORT;
    const resolved = resolveModel(effectiveModel);
    const effectiveTools = resolveTools(entry.agent.role, entry.agent.projectId);
    const attachmentBlock =
      attachments && attachments.length > 0 ? inlineAttachments(attachments) : '';
    const prompt = `${attachmentBlock}Forked from prior session. New direction:
${task}`;

    sinks.onLog(agentId, {
      ts: nowTs(),
      kind: 'note',
      msg: `Forked from ${entry.agent.forkedFromName ?? 'unknown'} (parent session ${parentSessionId})`,
    });

    const q = runClaudeQuery({
      cwd: entry.agent.workspace,
      env,
      prompt,
      abortController: controller,
      resume: parentSessionId,
      forkSession: true,
      agent: 'main',
      agents: {
        main: {
          description: `${role.label} for the Orchestrator app`,
          prompt: role.systemPrompt,
          tools: effectiveTools,
          model: resolved.model,
          effort: effectiveEffort,
        },
      },
      betas: resolved.betas,
    });

    await consumeQuery(agentId, q, controller, effectiveModel, sinks);
  } finally {
    clearInterval(elapsedTimer);
  }
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
  const elapsedTimer = startElapsedTimer(agentId, controller, sinks);

  try {
    // The agent's model + effort were resolved in spawnAgent and saved
    // to the registry. Read from there so we honour per-spawn overrides
    // (and any setAgentModel / setAgentEffort changes that landed between
    // spawnAgent and this point).
    const entry = registry.get(agentId);
    const effectiveModel = entry?.agent.model || settings.defaultModel || role.model;
    const effectiveEffort: EffortLevel =
      entry?.agent.effort || DEFAULT_EFFORT;
    // Pseudo-ids like `*-1m` resolve to a base model id + a beta header.
    const resolved = resolveModel(effectiveModel);
    const attachmentBlock =
      req.attachments && req.attachments.length > 0
        ? inlineAttachments(req.attachments)
        : '';
    const promptWithContext = `[workspace] ${workdir}
All file paths resolve here — your Read, Write, Edit, Glob, Grep tools all operate inside this folder. Use simple relative paths like "notes.md" (preferred) or the absolute path above.

Do NOT invent paths like /home/user/, /tmp/, or POSIX-style locations — they are not real on this system. Your bash 'pwd' may report this folder in MSYS form (e.g. /d/ClaudeCode/foo) which is equivalent to the Windows path above; file-tool calls should still use Windows-style or simple relative paths.

${attachmentBlock}Task:
${req.task}`;

    const effectiveTools = resolveTools(req.role, req.projectId);

    const q = runClaudeQuery({
      cwd: workdir,
      env,
      prompt: promptWithContext,
      abortController: controller,
      agent: 'main',
      agents: {
        main: {
          description: `${role.label} for the Orchestrator app`,
          prompt: role.systemPrompt,
          tools: effectiveTools,
          model: resolved.model,
          effort: effectiveEffort,
        },
      },
      betas: resolved.betas,
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

  runRedirect(
    req.agentId,
    req.body,
    req.attachments,
    req.model,
    req.effort,
    controller,
    sinks,
  )
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
  modelOverride: string | undefined,
  effortOverride: EffortLevel | undefined,
  controller: AbortController,
  sinks: RunnerSinks,
): Promise<void> {
  const entry = registry.get(agentId);
  if (!entry || !entry.agent.sessionId) return;
  const settings = readSettings();
  const env = buildEnv(settings);
  const elapsedTimer = startElapsedTimer(agentId, controller, sinks);

  // If the redirect comes with a new model/effort, persist it on the
  // agent so future redirects + the Drawer's Config tab show the latest.
  // The CLI call below explicitly passes both in the agent definition so
  // the resumed turn actually uses them (rather than inheriting the
  // session's original).
  const role = ROLES[entry.agent.role];
  const effectiveModel = modelOverride || entry.agent.model;
  const effectiveEffort: EffortLevel =
    effortOverride || entry.agent.effort || DEFAULT_EFFORT;
  const modelChanged = !!modelOverride && modelOverride !== entry.agent.model;
  const effortChanged =
    !!effortOverride && effortOverride !== entry.agent.effort;
  if (modelChanged || effortChanged) {
    const patch: Partial<typeof entry.agent> = {};
    if (modelChanged) patch.model = effectiveModel;
    if (effortChanged) patch.effort = effectiveEffort;
    registry.patch(agentId, patch);
    sinks.onPatch(agentId, patch);
  }
  const resolved = resolveModel(effectiveModel);

  try {
    const attachmentBlock =
      attachments && attachments.length > 0 ? inlineAttachments(attachments) : '';
    const prompt = `${attachmentBlock}Continuing task. New instruction:
${body}`;

    const parts: string[] = [];
    if (modelChanged) parts.push(`model → ${effectiveModel}`);
    if (effortChanged) parts.push(`effort → ${effectiveEffort}`);
    sinks.onLog(agentId, {
      ts: nowTs(),
      kind: 'note',
      msg: `Redirected — resuming session ${entry.agent.sessionId}${
        parts.length > 0 ? ` · ${parts.join(', ')}` : ''
      }`,
    });

    const q = runClaudeQuery({
      cwd: entry.agent.workspace,
      env,
      prompt,
      abortController: controller,
      resume: entry.agent.sessionId,
      // Pass the agent config explicitly so the resumed turn uses
      // our chosen model + tools + effort, not whatever the saved
      // session had.
      agent: 'main',
      agents: {
        main: {
          description: `${role.label} for the Orchestrator app`,
          prompt: role.systemPrompt,
          tools: resolveTools(entry.agent.role, entry.agent.projectId),
          model: resolved.model,
          effort: effectiveEffort,
        },
      },
      betas: resolved.betas,
    });

    await consumeQuery(agentId, q, controller, effectiveModel, sinks);
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
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
        is_error?: boolean;
        errors?: string[];
        result?: string;
      };
      // result.usage is for THIS run only; combine with base for cumulative.
      // Include cache_* token totals so we don't undercount Sonnet/Opus
      // prompts that hit cache (the bulk of input is usually a cached read).
      const u = result.usage ?? {};
      const resultRunInput =
        (Number(u.input_tokens) || 0) +
        (Number(u.cache_creation_input_tokens) || 0) +
        (Number(u.cache_read_input_tokens) || 0);
      const resultRunOutput = Number(u.output_tokens) || 0;
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
        // Notify the Director on every completion — user-spawned, Director-
        // spawned, or redirected. Director sees the live fleet block on each
        // turn and can decide whether to comment briefly or stay quiet.
        if (entry) {
          const summary = result.result ?? '';
          director.notifyAgentDone(
            entry.agent.projectId,
            entry.agent.name,
            summary,
          );
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
