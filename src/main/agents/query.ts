import type {
  Agent,
  EffortLevel,
  Provider,
} from '../../shared/types';
import { ROLES } from '../../shared/roles';
import { resolveModel } from '../../shared/models';
import * as registry from './registry';
import { classify, nowTs } from './classifier';
import { buildHandoffPayload } from './handoffPayload';
import * as director from '../director/runner';
import * as persistence from '../persistence';
import { prepareAttachments } from '../attachments';
import { getMcpConfigPath } from '../projects';
import { pluginDirsForProject, type LoadoutReport } from '../marketplace';
import { runClaudeQuery } from '../cli/spawn';
import { runCodexQuery } from '../cli/codex';
import {
  buildSystemPromptFor,
  LOG_TAIL_CAP,
  resolveTools,
  TERMINAL_STATUSES,
  type RunnerSinks,
} from './internal';
import {
  detectAndBumpSkillFires,
  safeResolveLoadout,
} from './skillFires';
import { extractMemoryProposalsFromEvent } from './memoryParse';

/**
 * Heart of the agent runner: builds the CLI invocation (`buildQuery`)
 * and drains its event stream (`consumeQuery`). The spawn / fork /
 * redirect modules each handle their own pre-flight (model resolution,
 * prompt prelude, attachment prep) but funnel through these two
 * functions for the actual CLI call + event-by-event bookkeeping.
 */

export interface BuildQueryArgs {
  agentId: string;
  agent: Agent;
  /** Prompt body the agent will see — already includes any prep.textInline + flow-specific prelude. */
  prompt: string;
  prep: ReturnType<typeof prepareAttachments>;
  provider: Provider;
  model: string;
  effort: EffortLevel;
  env: Record<string, string | undefined>;
  controller: AbortController;
  /** Session id to resume — set for redirect (agent's own) and fork (parent's). */
  resume?: string;
  /** True for fork (claude only — codex fork has no --json mode). */
  forkSession?: boolean;
  /** Emit the "Loading N skill bundles via --plugin-dir: …" note. Only `run` does. */
  emitPluginDirsNote?: boolean;
  sinks: RunnerSinks;
}

/**
 * Build the per-CLI iterable that consumeQuery drains. Used by the
 * shared core of run / runFork / runRedirect; the three call sites
 * still own their own prompt preludes (workspace context for run,
 * "Forked from prior session" for fork, "Continuing task" for
 * redirect), but everything downstream — CLI selection, role-prompt
 * preamble, plugin dirs, MCP config — lives here.
 */
export function buildQuery(args: BuildQueryArgs): AsyncIterable<unknown> {
  const {
    agent,
    prompt,
    prep,
    provider,
    model,
    effort,
    env,
    controller,
    resume,
    forkSession,
    emitPluginDirsNote,
    sinks,
    agentId,
  } = args;
  const role = ROLES[agent.role];
  const resolved = resolveModel(model);
  const effectiveTools = resolveTools(agent.role, agent.projectId);
  const projectId = agent.projectId;
  const systemPrompt = buildSystemPromptFor(agent.role, projectId, agent.subtype);

  if (emitPluginDirsNote && provider === 'claude') {
    const pluginDirs = pluginDirsForProject(projectId, agent.role);
    if (pluginDirs.length > 0) {
      const summary = pluginDirs
        .map((p) => p.split(/[/\\]/).pop() ?? p)
        .join(', ');
      sinks.onLog(agentId, {
        ts: nowTs(),
        kind: 'note',
        msg: `Loading ${pluginDirs.length} skill bundle${
          pluginDirs.length === 1 ? '' : 's'
        } via --plugin-dir: ${summary}`,
      });
    }
  }

  if (provider === 'codex') {
    return runCodexQuery({
      cwd: agent.workspace,
      env,
      // Codex has no inline system-prompt flag — bake the role
      // prompt into the user prompt as a preamble so the model
      // still sees its persona instructions.
      prompt: `[role: ${role.label}]\n${systemPrompt}\n\n---\n\n${prompt}`,
      model,
      effort,
      ...(resume ? { resume } : {}),
      // codex fork has no --json mode; forkAgent already gates
      // this at the entry point so forkSession will only ever be
      // true on the claude branch — but assert defensively.
      ...(forkSession ? { forkSession: true } : {}),
      abortController: controller,
    });
  }

  return runClaudeQuery({
    cwd: agent.workspace,
    env,
    prompt,
    ...(prep.images.length > 0 ? { images: prep.images } : {}),
    ...(prep.documents.length > 0 ? { documents: prep.documents } : {}),
    ...((p) => (p ? { mcpConfigPath: p } : {}))(getMcpConfigPath(projectId)),
    ...((dirs) => (dirs.length > 0 ? { pluginDirs: dirs } : {}))(
      pluginDirsForProject(projectId, agent.role),
    ),
    abortController: controller,
    ...(resume ? { resume } : {}),
    ...(forkSession ? { forkSession: true } : {}),
    agent: 'main',
    // Top-level --effort is what the CLI actually honors; the per-agent
    // effort in the agents block below is ignored by the CLI.
    effort,
    agents: {
      main: {
        description: `${role.label} for the Orchestrator app`,
        prompt: systemPrompt,
        tools: effectiveTools,
        model: resolved.model,
        effort,
      },
    },
    betas: resolved.betas,
  });
}

/**
 * Drain the CLI's event stream, updating the registry + sinks as turns
 * arrive. Handles three signals per event:
 *
 *   1. Capture session_id whenever the CLI surfaces one (Redirect
 *      needs it to resume the conversation later).
 *   2. Classify the event into LogLine[] and dispatch through sinks.
 *   3. Per-assistant turn: aggregate usage, push the per-turn NOTE
 *      diagnostic, enforce the budget caps, bump skill-fire counters.
 *   4. On `result` event: finalize totals, write the done/error patch,
 *      build the P14 structured-handoff payload and notify the Director.
 */
export async function consumeQuery(
  agentId: string,
  q: AsyncIterable<unknown>,
  controller: AbortController,
  sinks: RunnerSinks,
): Promise<void> {
  const entry0 = registry.get(agentId);
  if (!entry0) return;
  let turn = 0;

  // Resolve the loadout once per consumeQuery for skill-fire
  // attribution. Codex spawns can't load --plugin-dirs at all, so
  // skip the resolution for those provider types — saves a cheap
  // call but mostly keeps the intent clear: telemetry is a claude-
  // only signal.
  const fireLoadout: LoadoutReport | null =
    entry0.agent.provider === 'claude'
      ? safeResolveLoadout(entry0.agent.projectId, entry0.agent.role)
      : null;

  for await (const event of q) {
    if (controller.signal.aborted) break;
    // Once a terminal status has been written, stop draining the CLI
    // tail. Otherwise a buffered `result` event lands and its is_error
    // subtype overwrites a terminal status we already set (e.g. on abort).
    const guard = registry.get(agentId);
    if (guard && TERMINAL_STATUSES.has(guard.agent.status)) break;
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
      if (entry) {
        entry.agent.log.push(line);
        // H5: cap in-memory log to the last LOG_TAIL_CAP lines.
        // Older lines stay on disk via persistence.appendLogLine
        // above and are fetched on demand via listLogLinesForAgent.
        // Without this, a chatty long-running agent grew its log
        // array unbounded and `registry.listForProject` serialised
        // the whole thing over IPC on every renderer mount.
        if (entry.agent.log.length > LOG_TAIL_CAP) {
          entry.agent.log.splice(
            0,
            entry.agent.log.length - LOG_TAIL_CAP,
          );
        }
      }
      persistence.appendLogLine(agentId, line);
      sinks.onLog(agentId, line);
    }

    // Skill-fire telemetry — assistant events carry tool_use blocks
    // that signal which skills the agent actually consulted.
    if (fireLoadout && ev.type === 'assistant') {
      detectAndBumpSkillFires(
        ev,
        fireLoadout,
        entry0.agent.projectId,
        entry0.agent.role,
      );
    }

    // Memory proposals — agents emit `orchestrator-memory` fenced
    // blocks during their run; we land each one as a pending
    // proposal that the user approves/rejects from the Drawer's
    // Memory tab. Skipped for Director events (Director runs a
    // different parse pipeline) — this function is only ever called
    // with spawned-agent events.
    if (ev.type === 'assistant') {
      extractMemoryProposalsFromEvent(ev, {
        projectId: entry0.agent.projectId,
        role: entry0.agent.role,
        agentId: entry0.agent.id,
        agentName: entry0.agent.name,
      });
    }

    if (ev.type === 'assistant') {
      turn += 1;
      registry.patch(agentId, { step: `${turn}/?` });
      sinks.onPatch(agentId, { step: `${turn}/?` });
    } else if (ev.type === 'result') {
      const result = ev as unknown as {
        subtype: string;
        is_error?: boolean;
        errors?: string[];
        result?: string;
      };
      if (result.subtype === 'success') {
        sinks.onLog(agentId, {
          ts: nowTs(),
          kind: 'handoff',
          msg: 'Task complete',
        });
        const successPatch: Partial<Agent> = {
          status: 'done',
          statusLabel: 'Done',
        };
        registry.patch(agentId, successPatch);
        sinks.onPatch(agentId, successPatch);
        const entry = registry.get(agentId);
        // Notify the Director on every completion — user-spawned, Director-
        // spawned, or redirected. Director sees the live fleet block on each
        // turn and can decide whether to comment briefly or stay quiet.
        if (entry) {
          // P14: build a structured handoff payload from the agent's
          // accumulated log + the CLI's final result message before
          // notifying the Director. The Director then sees evidence
          // (files touched, test counts, todos, errors) as a fenced
          // JSON block on its next turn, not just prose.
          const summary = result.result ?? '';
          const payload = buildHandoffPayload(entry.agent, summary);
          director.notifyAgentDone(
            entry.agent.projectId,
            entry.agent.name,
            payload,
          );
        }
      } else {
        const errMsg = (result.errors ?? [result.subtype]).join(' · ');
        sinks.onLog(agentId, { ts: nowTs(), kind: 'error', msg: errMsg });
        const errorPatch: Partial<Agent> = {
          status: 'error',
          statusLabel: result.subtype,
        };
        registry.patch(agentId, errorPatch);
        sinks.onPatch(agentId, errorPatch);
      }
    }
  }
}
