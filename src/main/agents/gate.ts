import { spawn } from 'node:child_process';
import { getProject } from '../projects';
import * as registry from './registry';
import * as blackboard from '../blackboard';
import { redirectAgent } from './redirect';
import { awaitCompletion, type RunnerSinks } from './internal';

/** Hard ceiling on a single verification run. Test suites can be slow, so be
 *  generous — but never hang the plan forever on a wedged command. */
const GATE_TIMEOUT_MS = 10 * 60 * 1000;
/** How many bytes of command output we feed back + surface. */
const OUTPUT_CAP = 4000;
/** Default auto-fix attempts before surfacing + stopping. */
const DEFAULT_MAX_FIXES = 2;

/** Tail-cap + neutralise any triple-backtick runs so an embedded fence in the
 *  command output can't break the ``` fence we wrap it in when feeding it back
 *  to the agent as a redirect prompt. */
function cap(s: string): string {
  const t = s.trim().replace(/`{3,}/g, "'''");
  return t.length > OUTPUT_CAP ? '…' + t.slice(t.length - OUTPUT_CAP) : t;
}

/** Run the command in `cwd` via the platform shell. Resolves with the real
 *  exit code + captured stdout+stderr — never rejects. A timeout, signal kill,
 *  or spawn failure (e.g. command not found) is reported as a non-zero code so
 *  the gate treats it as a fail rather than a pass.
 *
 *  SECURITY — intentional `shell: true`, not an arg-array exec: `command` is
 *  the user's own per-project verification string (e.g. `npm run lint && npm
 *  test`). The shell is REQUIRED — it carries npm scripts, `&&` chains, globs,
 *  redirects — so an arg-array spawn would break the feature and force fragile
 *  manual tokenization. This is not untrusted input: it's a setting the single
 *  local user types themselves, and Orchestrator already runs its agents with
 *  `--permission-mode bypassPermissions` (arbitrary shell in this same
 *  workspace), so it introduces no new trust boundary. Empty command = the
 *  gate never runs.
 *
 *  Uses `spawn` (not `exec`) so the TRUE exit code is read from the 'close'
 *  event regardless of output volume — `exec`'s maxBuffer overflow on a
 *  green (exit-0) command would otherwise be misreported as a failure. Output
 *  is accumulated with a soft tail cap so a chatty suite can't exhaust memory. */
function runCommand(
  command: string,
  cwd: string,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    // spawn failures (bad cwd, shell missing) surface via the 'error' event,
    // not a sync throw — handled below. A command that doesn't exist exits
    // the shell non-zero and arrives via 'close', which is the fail we want.
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    // Retain a little more than we surface so cap() still has a full tail.
    const SOFT_CAP = OUTPUT_CAP * 4;
    let out = '';
    let timedOut = false;
    let settled = false;
    const append = (buf: Buffer) => {
      out += buf.toString();
      if (out.length > SOFT_CAP) out = out.slice(out.length - SOFT_CAP);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const done = (code: number, suffix = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output: `${out.trim()}${suffix}`.trim() });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, GATE_TIMEOUT_MS);
    child.on('error', (err) => done(1, out.trim() ? '' : `\n${err.message}`));
    child.on('close', (code) => {
      if (timedOut) {
        done(1, `\n\n[command timed out after ${GATE_TIMEOUT_MS / 60000} min]`);
        return;
      }
      // code is the real exit status, or null when killed by a signal.
      done(code == null ? 1 : code);
    });
  });
}

/**
 * N3: run the project's verification command once after an auto-mode plan
 * finishes. Pass (exit 0) → done. Fail → redirect the last agent with the
 * captured output to fix it, await its turn, and re-check, up to `maxFixes`
 * times; a still-failing gate surfaces the output and stops.
 *
 * Deterministic: only the exit code decides pass/fail — no model judges it.
 * No-ops when the project has no gate command configured. Abort-aware: if the
 * user aborts the agent at any point, the gate bails rather than resurrecting
 * the killed agent with another redirect. `notify` is injected (the caller
 * wires it to the Director's system-message channel) so this module stays free
 * of director imports.
 */
export async function runEndOfPlanGate(opts: {
  projectId: string;
  lastAgentId: string;
  sinks: RunnerSinks;
  notify: (msg: string) => void;
  maxFixes?: number;
}): Promise<void> {
  const { projectId, lastAgentId, sinks, notify } = opts;
  const maxFixes = opts.maxFixes ?? DEFAULT_MAX_FIXES;

  const command = getProject(projectId)?.gateCommand?.trim();
  if (!command) return; // gate off for this project

  const entry = registry.get(lastAgentId);
  const cwd = entry?.agent.workspace || getProject(projectId)?.workspace;
  if (!cwd) return;
  const agentName = entry?.agent.name ?? 'the last agent';

  // The user clicked Abort (on the row, or mid-fix). Never run / re-run the
  // command for, or redirect, an agent the user explicitly killed.
  const cancelled = () =>
    registry.get(lastAgentId)?.agent.status === 'aborted';
  if (cancelled()) return; // last plan agent was aborted — skip silently

  notify(`Verifying the plan — running \`${command}\`…`);

  let fixes = 0;
  for (;;) {
    const { code, output } = await runCommand(command, cwd);
    if (cancelled()) {
      notify('Verification cancelled — the last agent was aborted.');
      return;
    }
    if (code === 0) {
      notify(`✓ Verification passed — \`${command}\` is green.`);
      return;
    }
    if (fixes >= maxFixes) {
      notify(
        `✗ Verification still failing after ${maxFixes} fix attempt${
          maxFixes === 1 ? '' : 's'
        }. Stopping. \`${command}\` exited ${code}:\n\n\`\`\`\n${cap(output)}\n\`\`\``,
      );
      return;
    }
    // PRE-2a: a gate fix re-runs the agent — another director-driven spawn.
    // Stop before redirecting if the run already hit its spawn cap, rather than
    // minting work past the backstop.
    const budget = blackboard.spawnBudgetExhausted(projectId);
    if (budget.exhausted) {
      notify(
        `✗ Verification still failing, but the run hit its spawn cap (${budget.count}/${budget.cap} agents). Stopping. Raise "Max agents per run" in Settings to allow more fix attempts.`,
      );
      return;
    }
    fixes += 1;
    notify(
      `✗ Verification failed (exit ${code}). Redirecting ${agentName} to fix it (attempt ${fixes}/${maxFixes}).`,
    );
    const r = await redirectAgent(
      {
        agentId: lastAgentId,
        body:
          `The project verification command \`${command}\` failed after your changes (exit ${code}):\n\n` +
          `\`\`\`\n${cap(output)}\n\`\`\`\n\n` +
          `Fix these issues so that \`${command}\` passes, then finish.`,
      },
      sinks,
    );
    if (!r.ok) {
      notify(
        `Couldn't redirect ${agentName} to fix the verification failure: ${r.error}. Stopping.`,
      );
      return;
    }
    // Count the fix-redirect against the run's spawn cap.
    blackboard.recordSpawn(projectId);
    try {
      await awaitCompletion(lastAgentId);
    } catch {
      /* awaitCompletion never rejects, but be defensive */
    }
    if (cancelled()) {
      notify('Verification cancelled — the last agent was aborted.');
      return;
    }
  }
}
