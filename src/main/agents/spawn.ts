import { randomUUID } from 'node:crypto';
import type {
  Agent,
  AgentBudget,
  EffortLevel,
  Provider,
  SpawnAgentRequest,
} from '../../shared/types';
import { ROLES } from '../../shared/roles';
import { DEFAULT_EFFORT } from '../../shared/efforts';
import {
  defaultModelForProvider,
  modelMatchesProvider,
} from '../../shared/models';
import * as registry from './registry';
import { nowTs } from './classifier';
import { readSettings } from '../settings';
import * as persistence from '../persistence';
import { prepareAttachments } from '../attachments';
import { getProject } from '../projects';
import {
  buildEnv,
  nextName,
  startElapsedTimer,
  type AuthSettings,
  type RunnerSinks,
} from './internal';
import { buildQuery, consumeQuery } from './query';
import { trackCompletion } from './agent-lock';

/**
 * Initial spawn — mints a new agent row, registers it, and kicks off
 * the CLI run in the background. Returns immediately with the agent
 * id; events stream via the `sinks` callbacks the IPC layer wires
 * back to the renderer.
 *
 * The trackCompletion helper is unnecessary on a freshly-minted id
 * (no other caller can target it yet), but using the same helper as
 * redirect/fork keeps the cleanup story uniform.
 */
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
  // Provider-aware: if the project is codex, the fallback uses a codex
  // model, never the claude-flavoured settings.defaultModel. The
  // req.model is also validated against the project provider — if
  // someone managed to spawn with a mismatched id, we ignore it.
  const baseSettings = readSettings();
  // Resolve provider: explicit per-agent override wins over the project
  // default. The resolved value is stored on the agent so subsequent
  // run/redirect/fork code paths read it from the agent record (stable
  // even if project provider changes later).
  const projectProvider = getProject(req.projectId)?.provider ?? 'claude';
  const spawnProvider: Provider = req.provider ?? projectProvider;
  const requestedModel =
    req.model && modelMatchesProvider(req.model, spawnProvider)
      ? req.model
      : undefined;
  const effectiveModel =
    requestedModel ||
    (spawnProvider === 'claude'
      ? baseSettings.defaultModel || role.model
      : defaultModelForProvider(spawnProvider));
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
    provider: spawnProvider,
    ...(req.subtype ? { subtype: req.subtype } : {}),
    log: [],
    startedAt: Date.now(),
  };

  registry.add(agent, controller);
  persistence.saveAgent(agent);
  sinks.onAgent(agent);

  const settings = readSettings();

  // Fire-and-forget the async run; events stream via sinks.
  const work = run(id, req, req.workspace, settings, controller, sinks);
  trackCompletion(id, work);
  work.catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    sinks.onLog(id, { ts: nowTs(), kind: 'error', msg: `runner crashed: ${msg}` });
    // F8 + persistence fix: route through registry.patch so the
    // in-memory agent + DB row catch the terminal state (previously
    // only the renderer was notified — a hydrate-from-disk would
    // resurrect the row as 'running'). registry.patch mutates the
    // patch object to stamp endedAt before we hand it to sinks.
    const patch: Partial<import('../../shared/types').Agent> = {
      status: 'error',
      statusLabel: 'Crashed',
    };
    registry.patch(id, patch);
    sinks.onPatch(id, patch);
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
  const env = buildEnv(settings, req.projectId);
  const elapsedTimer = startElapsedTimer(agentId, controller, sinks);

  try {
    // The agent's model + effort were resolved in spawnAgent and saved
    // to the registry. Read from there so we honour per-spawn overrides
    // (and any setAgentModel / setAgentEffort changes that landed between
    // spawnAgent and this point). The fallback respects project provider
    // and validates the stored model id against it.
    const entry = registry.get(agentId);
    if (!entry) return;
    // Honour the per-agent provider override stored at spawn time;
    // fall back to the project's provider for agents persisted before
    // schema v13.
    const runProvider: Provider =
      entry.agent.provider ??
      getProject(req.projectId)?.provider ??
      'claude';
    const storedAgentModel =
      entry.agent.model && modelMatchesProvider(entry.agent.model, runProvider)
        ? entry.agent.model
        : undefined;
    const effectiveModel =
      storedAgentModel ||
      (runProvider === 'claude'
        ? settings.defaultModel || role.model
        : defaultModelForProvider(runProvider));
    const effectiveEffort: EffortLevel =
      entry.agent.effort || DEFAULT_EFFORT;
    const prep = prepareAttachments(req.attachments, runProvider);
    for (const line of prep.warnLines) {
      sinks.onLog(agentId, { ts: nowTs(), kind: 'warn', msg: line });
    }
    const promptWithContext = `[workspace] ${workdir}
All file paths resolve here — your Read, Write, Edit, Glob, Grep tools all operate inside this folder. Use simple relative paths like "notes.md" (preferred) or the absolute path above.

Do NOT invent paths like /home/user/, /tmp/, or POSIX-style locations — they are not real on this system. Your bash 'pwd' may report this folder in MSYS form (e.g. /d/ClaudeCode/foo) which is equivalent to the Windows path above; file-tool calls should still use Windows-style or simple relative paths.

${prep.textInline}Task:
${req.task}`;

    const q = buildQuery({
      agent: entry.agent,
      prompt: promptWithContext,
      prep,
      provider: runProvider,
      model: effectiveModel,
      effort: effectiveEffort,
      env,
      controller,
      sinks,
      agentId,
      // Initial spawn diagnostic — fork/redirect skip this because
      // the same plugin-dirs were already logged when the parent
      // spawned.
      emitPluginDirsNote: true,
    });

    await consumeQuery(agentId, q, controller, effectiveModel, sinks);
  } finally {
    clearInterval(elapsedTimer);
  }
}
