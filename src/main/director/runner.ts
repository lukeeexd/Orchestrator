import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { app } from 'electron';
import type {
  DirectorMessage,
  DirectorMode,
  EffortLevel,
  PlanRow,
  PlanCritique,
  RunLedger,
} from '../../shared/types';
import { DEFAULT_EFFORT } from '../../shared/efforts';
import {
  defaultModelForProvider,
  modelMatchesProvider,
  resolveModel,
} from '../../shared/models';
import { runClaudeQuery } from '../cli/spawn';
import { runCodexQuery } from '../cli/codex';
import { readSettings } from '../settings';
import { effectiveSkill } from '../skills';
import { stripOrchestratorFences } from '../sanitize';
import { DIRECTOR_SYSTEM_PROMPT } from './prompt';
import { extractDirectives } from './parse';
import { runPlanCritic } from './critic';
import { nowTs } from '../agents/classifier';
import * as persistence from '../persistence';
import { prepareAttachments } from '../attachments';
import * as registry from '../agents/registry';
import { getMcpConfigPath, getProject } from '../projects';
import {
  availableSkillsByRole as getMarketplaceSkillsByRole,
  pluginDirsForProject,
} from '../marketplace';

// R-A8 fence-stripping lives in ../sanitize (shared with the N6 run-digest
// injection path, which hardens agent→agent prompt context the same way).

/**
 * Build the Director's effective system prompt: the hardcoded base
 * plus any per-project Director skill the user has authored. Empty
 * skill is a no-op.
 */
function buildDirectorSystemPrompt(projectId: string): string {
  const skill = effectiveSkill(projectId, 'director').trim();
  if (!skill) return DIRECTOR_SYSTEM_PROMPT;
  return `${DIRECTOR_SYSTEM_PROMPT}\n\n## Project guidance\n\n${skill}`;
}

export interface DirectorSinks {
  onMessage: (projectId: string, msg: DirectorMessage) => void;
  onPatch: (projectId: string, id: string, patch: Partial<DirectorMessage>) => void;
}

type QueueEntry =
  | { kind: 'user'; body: string; mode: DirectorMode; attachments?: string[] }
  | {
      kind: 'system';
      body: string;
      mode: DirectorMode;
      /** N5: present when this is an auto-replan turn — stamped onto the plan it emits. */
      replan?: { of: string; attempt: number };
    };

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
  // Set by abort(); consulted at the top of each runTurn so an
  // abort landing between turns (queue draining + new turn
  // starting) isn't silently dropped by the unconditional
  // `this.controller = new AbortController()` at runTurn entry.
  private pendingAbort = false;

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
    this.pendingAbort = true;
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

  /**
   * F5: rewind the conversation to (and including) the chosen
   * message. Aborts any in-flight turn, truncates messages after
   * the anchor in both in-memory state and the DB, and clears the
   * saved SDK session id so the next user turn starts fresh — no
   * `--resume` against truncated history. Returns the count of
   * messages dropped so the renderer can surface a confirmation.
   */
  rewindTo(messageId: string): {
    ok: boolean;
    truncatedCount: number;
    error?: string;
  } {
    this.abort();
    const idx = this.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) {
      return { ok: false, truncatedCount: 0, error: 'message not found' };
    }
    const dbResult = persistence.rewindDirectorMessagesTo(
      this.projectId,
      messageId,
    );
    if (!dbResult.ok) return dbResult;
    this.messages = this.messages.slice(0, idx + 1);
    this.sessionId = null;
    this.queue = [];
    this.busy = false;
    persistence.clearDirectorSessionId(this.projectId);
    return { ok: true, truncatedCount: dbResult.truncatedCount };
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

  /**
   * Push a free-form system message into the chat. Used for audit-
   * trail events like "MCP config updated — these commands will
   * execute on every spawn" so the user has a persistent visible
   * record of trust-relevant decisions.
   *
   * Doesn't queue a Director turn — pure UI notification.
   */
  notifySystem(body: string): void {
    this.pushMessage({
      id: randomUUID(),
      projectId: this.projectId,
      who: 'system',
      name: 'system',
      time: timeOnly(),
      body,
    });
  }

  notifyAgentDone(
    agentName: string,
    payload: import('../../shared/types').HandoffPayload,
  ): void {
    // P14: structured handoff. The Director's queued [handoff] body
    // carries machine-readable evidence as a fenced JSON block under
    // a stable label so the Director can reason about facts (which
    // files changed, did the tests pass, are there explicit todos)
    // instead of parsing prose. The leading prose line stays so the
    // body is still readable when surfaced verbatim somewhere.
    //
    // R-A8: scrub any `orchestrator-*` fence from the agent's
    // summary before it lands in the Director's input. A malicious
    // or buggy agent that emits one of those fences would otherwise
    // get its directive interpreted as Director output on the next
    // turn via `extractDirectives`. The Director should interpret
    // its OWN output only — agent prose is observation, not
    // instruction.
    const safeSummary = stripOrchestratorFences(payload.summary);
    const safePayload = { ...payload, summary: safeSummary };
    const proseSummary = safeSummary
      ? `Summary: ${safeSummary}`
      : 'No summary.';
    const body =
      `[handoff] Agent ${agentName} completed. ${proseSummary}\n\n` +
      '```json handoff-payload\n' +
      JSON.stringify(safePayload, null, 2) +
      '\n```';
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

  /**
   * N5 auto-replan: after a run stalls, queue a Director turn that emits a
   * REVISED plan for the remaining work. `promptBody` is built by the caller
   * (the accept loop) from the blackboard evidence + remaining rows, while the
   * run is still active. Bounded by the `maxReplansPerRun` setting:
   * `planMessageId` is the stalled plan's message, the new attempt = its replan
   * depth + 1; if that exceeds the cap (or the cap is 0/off) we do NOT offer a
   * replan and return false, so the caller just pauses instead. The emitted
   * plan surfaces as a normal PlanCard — user-approved, never auto-spawned —
   * tagged with replan provenance for the "revised after a stall" badge.
   * Returns true if a replan turn was queued.
   */
  requestReplan(planMessageId: string, promptBody: string): boolean {
    const max = readSettings().maxReplansPerRun ?? 0;
    if (max <= 0) return false;
    const cur = this.messages.find((m) => m.id === planMessageId);
    const attempt = (cur?.replan?.attempt ?? 0) + 1;
    if (attempt > max) return false;
    this.pushMessage({
      id: randomUUID(),
      projectId: this.projectId,
      who: 'system',
      name: 'system',
      time: timeOnly(),
      body: `⟳ Run stalled — the Director is revising the plan (auto-replan ${attempt}/${max})…`,
    });
    this.queue.push({
      kind: 'system',
      body: promptBody,
      // Replans only make sense in auto mode — a plan must be emitted.
      mode: 'auto',
      replan: { of: planMessageId, attempt },
    });
    void this.pump();
    return true;
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

  /**
   * N5: patch the live progress ledger onto the plan's message. The accept
   * loop derives the ledger after each row completes and calls this; it rides
   * the same patch→broadcast path as `critique`/`confidence`, so it persists
   * and pushes to the renderer with no separate channel. No-ops silently if
   * the plan message is gone (e.g. the chat was wiped mid-run) so a detached
   * loop can't resurrect a deleted message.
   */
  updateLedger(planMessageId: string, ledger: RunLedger): void {
    if (!this.messages.some((m) => m.id === planMessageId)) return;
    this.patchMessage(planMessageId, { ledger });
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
        // Honour an abort that landed between turns. Without this,
        // queued messages would keep firing fresh runTurn calls
        // (each minting a brand new controller) even though the
        // user already aborted.
        if (this.pendingAbort) {
          this.queue.length = 0;
          break;
        }
        const next = this.queue.shift();
        if (!next) break;
        const attachments = next.kind === 'user' ? next.attachments : undefined;
        const replan = next.kind === 'system' ? next.replan : undefined;
        await this.runTurn(next.body, next.mode, attachments, replan);
      }
    } finally {
      this.busy = false;
      // Reset the flag at end of drain so a future user message can
      // resume the conversation. Mirrors the abort/resume model in
      // the renderer (Director isn't terminated, just interrupted).
      this.pendingAbort = false;
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

  /**
   * Build a `[project skills]` block listing the marketplace skills
   * each agent role will have loaded. Empty when no role has any
   * skill — keeps the prompt tight for projects without subscriptions.
   * Descriptions are truncated to 80 chars so a 30-skill bundle
   * doesn't blow out the Director's context per turn.
   */
  private buildSkillsBlock(): string {
    const byRole = getMarketplaceSkillsByRole(this.projectId);
    const order = [
      'pm',
      'researcher',
      'coder',
      'qa',
      'devops',
      'security',
      'director',
    ];
    const anyHasSkills = order.some((r) => (byRole[r] ?? []).length > 0);
    if (!anyHasSkills) return '';
    const lines: string[] = ['[project skills — auto-loaded via --plugin-dir]'];
    for (const role of order) {
      const skills = byRole[role] ?? [];
      if (skills.length === 0) {
        lines.push(`${role}: none`);
        continue;
      }
      lines.push(`${role}:`);
      for (const s of skills) {
        const desc =
          s.description && s.description.length > 0
            ? ' — ' +
              (s.description.length > 80
                ? s.description.slice(0, 80) + '…'
                : s.description)
            : '';
        const name = s.name && s.name !== s.id ? ` (${s.name})` : '';
        lines.push(`  - ${s.id}${name}${desc}`);
      }
    }
    lines.push('[/project skills]');
    return lines.join('\n') + '\n\n';
  }

  private async runTurn(
    promptBody: string,
    mode: DirectorMode,
    attachments?: string[],
    replan?: { of: string; attempt: number },
  ): Promise<void> {
    const settings = readSettings();
    const env: Record<string, string | undefined> = { ...process.env };
    if (settings.oauthToken) {
      env.CLAUDE_CODE_OAUTH_TOKEN = settings.oauthToken;
      delete env.ANTHROPIC_API_KEY;
    } else if (settings.apiKey) {
      env.ANTHROPIC_API_KEY = settings.apiKey;
    }

    // Late-arriving abort: pump() already guards this, but if a
    // race lets us reach runTurn after abort was called, bail before
    // minting a fresh controller that the original abort signal
    // can't reach.
    if (this.pendingAbort) return;
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
    // gets a heavier model out of the box. The fallback respects the
    // project's provider so a codex project doesn't end up trying to
    // spawn `codex exec -m claude-opus-4-8-1m` (which is what happened
    // before this branch was provider-aware — silent empty response).
    const project = getProject(this.projectId);
    // The Director can opt into a different CLI than the agents via
    // project.directorProvider — e.g. claude Director orchestrating a
    // fleet of codex specialists. Falls through to the project's main
    // provider when unset.
    const provider =
      project?.directorProvider ?? project?.provider ?? 'claude';
    // The persisted directorModel might be stale (e.g. left over from
    // before the project was a codex project, or hand-edited). Validate
    // it matches the Director's effective provider — if not, fall
    // through to the provider's default. Without this, `codex exec -m
    // claude-opus-4-8-1m` returns an empty agent_message and the
    // Director chat shows "(empty response)" with no clue why.
    const persistedDirector =
      project?.directorModel && modelMatchesProvider(project.directorModel, provider)
        ? project.directorModel
        : undefined;
    const directorModel =
      persistedDirector ||
      (provider === 'claude'
        ? settings.defaultDirectorModel ||
          settings.defaultModel ||
          'claude-opus-4-8-1m'
        : defaultModelForProvider(provider));
    const directorEffort: EffortLevel =
      project?.directorEffort ||
      settings.defaultDirectorEffort ||
      settings.defaultEffort ||
      DEFAULT_EFFORT;
    const resolved = resolveModel(directorModel);

    try {
      const prep = prepareAttachments(attachments, provider);
      if (prep.warnLines.length > 0) {
        // Surface skipped/oversize/codex-unsupported attachment warnings
        // as a system message in the chat. One bundled message keeps the
        // noise down when several files are involved.
        this.pushMessage({
          id: randomUUID(),
          projectId: this.projectId,
          who: 'system',
          name: 'system',
          time: timeOnly(),
          body: prep.warnLines.join('\n'),
        });
      }
      const agentBlock = this.buildFleetBlock();
      const skillsBlock = this.buildSkillsBlock();
      const fullPrompt = `[mode: ${mode}]\n${skillsBlock}${agentBlock}${prep.textInline}${promptBody}`;

      // Codex tends to skip the fenced JSON block when it thinks a
      // task is "trivial" and just describe the answer in prose,
      // which leaves our parser with nothing to act on. The
      // end-of-prompt reminder pulls it back. Manual mode has no
      // block to emit (Director acts as an advisor), so no reminder.
      const codexReminder =
        mode === 'auto'
          ? '\n\n---\n\nREMINDER (auto mode): Emit a fenced JSON block — either `orchestrator-plan` to spawn the fleet, OR `orchestrator-questions` (max 3) if the task is too ambiguous to plan well. Never both. Do not answer in prose only — our parser needs the block. If the task is trivial, just emit a one-row plan; don\'t ask.'
          : mode === 'prd'
            ? '\n\n---\n\nREMINDER (prd mode): Always emit the `orchestrator-prd` fenced JSON block. Do not write the PRD in prose only — our parser needs the block to render the PRD card.'
            : '';

      const q =
        provider === 'codex'
          ? runCodexQuery({
              cwd: app.getPath('userData'),
              env,
              // Codex has no inline system-prompt knob; prepend the
              // Director instructions as a preamble.
              prompt: `[director-role]\n${buildDirectorSystemPrompt(this.projectId)}\n\n---\n\n${fullPrompt}${codexReminder}`,
              model: directorModel,
              effort: directorEffort,
              // The Director only plans — it never edits files. read-only
              // sandbox avoids codex trying to set up workspace-write
              // mounts in app.getPath('userData') which isn't a real
              // project dir (and codex exits 1 trying).
              sandbox: 'read-only',
              resume: this.sessionId ?? undefined,
              abortController: this.controller,
            })
          : runClaudeQuery({
              cwd: app.getPath('userData'),
              env,
              prompt: fullPrompt,
              ...(prep.images.length > 0 ? { images: prep.images } : {}),
              ...(prep.documents.length > 0
                ? { documents: prep.documents }
                : {}),
              ...((p) => (p ? { mcpConfigPath: p } : {}))(
                getMcpConfigPath(this.projectId),
              ),
              ...((dirs) => (dirs.length > 0 ? { pluginDirs: dirs } : {}))(
                pluginDirsForProject(this.projectId, 'director'),
              ),
              abortController: this.controller,
              agent: 'director',
              // Top-level --effort is the only effort the CLI honors; the
              // effort inside the agents block below is ignored by the CLI.
              effort: directorEffort,
              agents: {
                director: {
                  description: 'Orchestrator director — plans and supervises agents.',
                  prompt: buildDirectorSystemPrompt(this.projectId),
                  tools: [] as string[],
                  model: resolved.model,
                  effort: directorEffort,
                },
              },
              ...(this.sessionId ? { resume: this.sessionId } : {}),
              betas: resolved.betas,
            });

      let bodyBuf = '';
      let runtimeError: string | null = null;
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
          const result = ev as unknown as {
            session_id?: string;
            subtype?: string;
            is_error?: boolean;
            errors?: string[];
          };
          if (result.session_id) {
            this.sessionId = result.session_id;
            persistence.saveDirectorSessionId(this.projectId, result.session_id);
          }
          // Surface non-success result events. Without this, codex's
          // process_error / spawn_error / parse_error events were silently
          // discarded and the chat just showed "(empty response)" with no
          // indication of what went wrong.
          if (result.is_error || (result.subtype && result.subtype !== 'success')) {
            const reason = (result.errors ?? [result.subtype ?? 'unknown']).join(' · ');
            runtimeError = reason;
          }
        }
      }

      const { text, plan, redirect, prd, questions, confidence } =
        extractDirectives(bodyBuf);
      // Plans are an AUTO-mode artifact. Manual mode = the user drives the
      // spawns (Director only advises); prd mode = it emits a brief. A stray
      // orchestrator-plan block in either mode must be dropped — otherwise
      // PlanCard's Spawn button (and the N3 verification gate that accepting
      // a plan triggers) would fire where spawning isn't the intent. Enforced
      // here because this is where the producing mode is authoritative (the
      // renderer's `mode` prop is the live toggle, not the mode that produced
      // the plan).
      const effectivePlan = mode === 'auto' ? plan : null;
      // N8: clarifying questions are an AUTO-mode alternative to a plan. A plan
      // always wins (drop questions if both somehow appear), and they never
      // render outside auto mode (manual = prose advice, prd = the brief).
      const effectiveQuestions =
        effectivePlan || mode !== 'auto' ? undefined : questions ?? undefined;
      // N9: confidence is a property OF a plan — only attach it when a plan
      // actually rides this turn. A confidence block without a plan (or in
      // PRD mode where the plan was dropped) is meaningless, so discard it.
      const effectiveConfidence = effectivePlan
        ? confidence ?? undefined
        : undefined;
      const fallbackBody = runtimeError
        ? `Error: ${runtimeError}`
        : '(empty response)';
      // N7 Plan Critic: one extra cheap-model call between plan-emit and the
      // final patch. Advisory only — returns null on skip/failure and never
      // blocks the turn. Folds into the SAME patch so the annotations land
      // with the plan (one render, no un-critiqued flash). The critic self-
      // gates (claude-only, >=3 rows) and reuses this turn's controller so a
      // Director abort cancels it too.
      let critique: PlanCritique | undefined;
      if (effectivePlan && this.controller && !this.controller.signal.aborted) {
        critique =
          (await runPlanCritic({
            projectId: this.projectId,
            rows: effectivePlan,
            env,
            provider,
            controller: this.controller,
          })) ?? undefined;
      }
      this.patchMessage(directorMessage.id, {
        body:
          text ||
          (effectivePlan || redirect || prd || effectiveQuestions
            ? ''
            : fallbackBody),
        plan: effectivePlan ?? undefined,
        redirect: redirect ?? undefined,
        prd: prd ?? undefined,
        critique,
        questions: effectiveQuestions,
        confidence: effectiveConfidence,
        // N5: stamp replan provenance when this turn was an auto-replan AND it
        // actually produced a plan (a replan turn that asks questions instead
        // isn't a revised plan).
        replan: effectivePlan && replan ? replan : undefined,
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
 * Drop the in-memory Director session and clear its persisted SDK
 * session id, leaving the chat-message history intact. The next
 * sendFromUser lazily creates a new session with a null `sessionId`,
 * so the new provider's CLI gets a fresh start rather than trying to
 * resume a session id it can't read.
 *
 * Used when a project's Director provider is changed mid-run — the
 * claude and codex CLIs don't share session formats, so any saved id
 * becomes garbage to the new CLI.
 */
/**
 * Drop any persisted Director session id for this project. Call this
 * from EVERY IPC handler that mutates `project.provider` or
 * `project.directorProvider` — the saved session id is provider-
 * specific (claude SDK shape vs codex's `--resume` shape) and a
 * stale id makes the next turn fail with a confusing "session not
 * found" error.
 *
 * R-M8: today only `ProjectSetDirectorProvider` mutates a provider
 * field. If a future `ProjectSetProvider` channel is added it MUST
 * call this — the cascade resolution (directorProvider → provider)
 * means project.provider change matters even if directorProvider
 * was already set.
 */
export function resetSessionForProviderChange(projectId: string): void {
  sessions.get(projectId)?.abort();
  sessions.delete(projectId);
  persistence.clearDirectorSessionId(projectId);
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

/**
 * F5: rewind the project's Director session to a chosen anchor
 * message. Module-level entry point for the IPC handler; delegates
 * to the session's `rewindTo`.
 */
export function rewindTo(
  projectId: string,
  messageId: string,
): { ok: boolean; truncatedCount: number; error?: string } {
  return getSession(projectId).rewindTo(messageId);
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
  payload: import('../../shared/types').HandoffPayload,
): void {
  getSession(projectId).notifyAgentDone(agentName, payload);
}

export function notifySystem(projectId: string, body: string): void {
  getSession(projectId).notifySystem(body);
}

export function updateLedger(
  projectId: string,
  planMessageId: string,
  ledger: RunLedger,
): void {
  getSession(projectId).updateLedger(planMessageId, ledger);
}

export function requestReplan(
  projectId: string,
  planMessageId: string,
  promptBody: string,
): boolean {
  return getSession(projectId).requestReplan(planMessageId, promptBody);
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
