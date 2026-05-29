import { randomUUID } from 'node:crypto';
import type {
  Agent,
  EffortLevel,
  ForkAgentRequest,
} from '../../shared/types';
import { ROLES } from '../../shared/roles';
import { DEFAULT_EFFORT } from '../../shared/efforts';
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
  type RunnerSinks,
} from './internal';
import { buildQuery, consumeQuery } from './query';
import { trackCompletion, withAgentLock } from './agent-lock';

/**
 * Branch a new agent off an existing one's conversation. Uses the
 * CLI's `resume: parent.sessionId, forkSession: true` combo so the
 * fork starts with the parent's full chat history but writes to a
 * fresh session id — the parent stays intact and untouched.
 *
 * Locks on the parent: the fork reads parent.sessionId atomically
 * and a concurrent redirect on the parent could otherwise swap the
 * session out from under us mid-read.
 */
export async function forkAgent(
  req: ForkAgentRequest,
  sinks: RunnerSinks,
): Promise<{ ok: boolean; agentId?: string; error?: string }> {
  return withAgentLock(req.parentAgentId, () => forkAgentLocked(req, sinks));
}

async function forkAgentLocked(
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
  // Fork inherits the parent agent's provider, which may differ from
  // the project default (per-agent override). The codex fork restriction
  // is provider-specific, not project-specific, so we gate on the
  // parent's effective provider.
  const provider =
    parent.agent.provider ??
    getProject(parent.agent.projectId)?.provider ??
    'claude';
  if (provider === 'codex') {
    return {
      ok: false,
      error:
        'fork is not supported for codex agents yet — codex exec exposes JSON resume, but not JSON fork',
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
    provider: parent.agent.provider,
    log: [],
    startedAt: Date.now(),
    forkedFromId: parent.agent.id,
    forkedFromName: parent.agent.name,
  };

  registry.add(agent, controller);
  persistence.saveAgent(agent);
  sinks.onAgent(agent);

  const work = runFork(
    id,
    parent.agent.sessionId,
    req.task,
    req.attachments,
    controller,
    sinks,
  );
  trackCompletion(id, work);
  work.catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    sinks.onLog(id, {
      ts: nowTs(),
      kind: 'error',
      msg: `fork crashed: ${msg}`,
    });
    // F8 + persistence fix: route through registry.patch so DB + the
    // in-memory agent catch the terminal state and pick up endedAt.
    const patch: Partial<import('../../shared/types').Agent> = {
      status: 'error',
      statusLabel: 'Crashed',
    };
    registry.patch(id, patch);
    sinks.onPatch(id, patch);
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
  const env = buildEnv(settings, entry.agent.projectId);
  const elapsedTimer = startElapsedTimer(agentId, sinks);

  try {
    // Forks already inherit their parent's stored provider in
    // forkAgent. Honour that here rather than re-reading project, so
    // a fork of an overridden-provider parent stays consistent even
    // if the project provider has since changed.
    const project = getProject(entry.agent.projectId);
    const provider =
      entry.agent.provider ?? project?.provider ?? 'claude';
    const prep = prepareAttachments(attachments, provider);
    for (const line of prep.warnLines) {
      sinks.onLog(agentId, { ts: nowTs(), kind: 'warn', msg: line });
    }
    const prompt = `${prep.textInline}Forked from prior session. New direction:
${task}`;

    sinks.onLog(agentId, {
      ts: nowTs(),
      kind: 'note',
      msg: `Forked from ${entry.agent.forkedFromName ?? 'unknown'} (parent session ${parentSessionId})`,
    });

    const effectiveModel = entry.agent.model;
    const effectiveEffort = entry.agent.effort || DEFAULT_EFFORT;

    const q = buildQuery({
      agent: entry.agent,
      prompt,
      prep,
      provider,
      model: effectiveModel,
      effort: effectiveEffort,
      env,
      controller,
      resume: parentSessionId,
      forkSession: true,
      sinks,
      agentId,
    });

    await consumeQuery(agentId, q, controller, sinks);
  } finally {
    clearInterval(elapsedTimer);
  }
}
