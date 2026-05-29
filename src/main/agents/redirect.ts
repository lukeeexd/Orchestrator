import type {
  EffortLevel,
  RedirectAgentRequest,
} from '../../shared/types';
import { DEFAULT_EFFORT } from '../../shared/efforts';
import * as registry from './registry';
import { nowTs } from './classifier';
import { readSettings } from '../settings';
import { prepareAttachments } from '../attachments';
import { getProject } from '../projects';
import {
  buildEnv,
  elapsed,
  startElapsedTimer,
  type RunnerSinks,
} from './internal';
import { buildQuery, consumeQuery } from './query';
import { trackCompletion, withAgentLock } from './agent-lock';

/**
 * Continue a done/error agent's CLI session with a new user message.
 * Uses `options.resume = agent.sessionId` so conversation memory + tools
 * + system prompt are all carried over from the original spawn.
 *
 * Locks the agent id: the [status check → status flip → controller
 * swap → kick off work] sequence must be atomic, otherwise two
 * redirects in the same tick both pass the 'running' guard and the
 * first controller leaks unreferenced.
 */
export async function redirectAgent(
  req: RedirectAgentRequest,
  sinks: RunnerSinks,
): Promise<{ ok: boolean; error?: string }> {
  return withAgentLock(req.agentId, () => redirectAgentLocked(req, sinks));
}

async function redirectAgentLocked(
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

  const work = runRedirect(
    req.agentId,
    req.body,
    req.attachments,
    req.model,
    req.effort,
    controller,
    sinks,
  );
  trackCompletion(req.agentId, work);
  work.catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    sinks.onLog(req.agentId, {
      ts: nowTs(),
      kind: 'error',
      msg: `redirect crashed: ${msg}`,
    });
    // F8 + persistence fix: route through registry.patch so DB + the
    // in-memory agent catch the terminal state and pick up endedAt.
    const patch: Partial<import('../../shared/types').Agent> = {
      status: 'error',
      statusLabel: 'Crashed',
    };
    registry.patch(req.agentId, patch);
    sinks.onPatch(req.agentId, patch);
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
  const env = buildEnv(settings, entry.agent.projectId);
  // Time this redirect turn from NOW, not the original spawn — the agent may
  // have been done/idle for minutes. Reset the displayed elapsed immediately
  // so it doesn't flash the prior turn's value before the first tick.
  const turnStart = Date.now();
  registry.patch(agentId, { elapsed: elapsed(turnStart) });
  sinks.onPatch(agentId, { elapsed: elapsed(turnStart) });
  const elapsedTimer = startElapsedTimer(agentId, sinks, turnStart);

  // If the redirect comes with a new model/effort, persist it on the
  // agent so future redirects + the Drawer's Config tab show the latest.
  // The CLI call below explicitly passes both in the agent definition so
  // the resumed turn actually uses them (rather than inheriting the
  // session's original).
  const effectiveModel = modelOverride || entry.agent.model;
  const effectiveEffort: EffortLevel =
    effortOverride || entry.agent.effort || DEFAULT_EFFORT;
  const modelChanged = !!modelOverride && modelOverride !== entry.agent.model;
  const effortChanged =
    !!effortOverride && effortOverride !== entry.agent.effort;
  // Bug fix: the row, stream header, and Drawer all read `agent.task`.
  // Before this, redirect updated model/effort but left task pointing
  // at the original spawn instruction — so the agent would visibly be
  // working on a new direction while the headline still showed the
  // old one. Mirror fork.ts which sets task = req.task on the new
  // agent.
  const trimmed = body.trim();
  const taskChanged = trimmed.length > 0 && trimmed !== entry.agent.task;
  if (modelChanged || effortChanged || taskChanged) {
    const patch: Partial<typeof entry.agent> = {};
    if (modelChanged) patch.model = effectiveModel;
    if (effortChanged) patch.effort = effectiveEffort;
    if (taskChanged) patch.task = trimmed;
    registry.patch(agentId, patch);
    sinks.onPatch(agentId, patch);
  }
  try {
    // Redirect uses the provider the agent originally spawned with —
    // resuming a session on a different provider doesn't make sense
    // (the session id is tied to one CLI).
    const project = getProject(entry.agent.projectId);
    const provider =
      entry.agent.provider ?? project?.provider ?? 'claude';
    const prep = prepareAttachments(attachments, provider);
    for (const line of prep.warnLines) {
      sinks.onLog(agentId, { ts: nowTs(), kind: 'warn', msg: line });
    }
    const prompt = `${prep.textInline}Continuing task. New instruction:
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

    const q = buildQuery({
      agent: entry.agent,
      prompt,
      prep,
      provider,
      model: effectiveModel,
      effort: effectiveEffort,
      env,
      controller,
      resume: entry.agent.sessionId,
      sinks,
      agentId,
    });

    await consumeQuery(agentId, q, controller, sinks);
  } finally {
    clearInterval(elapsedTimer);
  }
}
