import { app } from 'electron';
import type { PlanRow, PlanCritique, Provider } from '../../shared/types';
import { AGENT_ROLE_ORDER, ROLES } from '../../shared/roles';
import { cheapestModelForProvider, resolveModel } from '../../shared/models';
import { resolveTools } from '../agents/internal';
import { runClaudeQuery } from '../cli/spawn';
import { extractCritique } from './parse';

/**
 * N7 Plan Critic — a one-shot, cheap-model adversarial review of a plan BEFORE
 * any agent spawns. It catches the most expensive failure (a multi-row fleet
 * off a bad plan) while it's still free to fix. ADVISORY only: it returns null
 * on any skip/failure and never throws into the Director turn or blocks
 * spawning. claude-only.
 *
 * It calls `runClaudeQuery` directly — the same low-level primitive the
 * Director uses for its own turn — NOT the agent-lifecycle buildQuery/
 * consumeQuery (which need a registry entry and fire status/persistence/
 * telemetry the critic must not touch).
 */

/** Skip trivial plans — don't tax 1-2 row plans with a critic call. */
const CRITIC_MIN_ROWS = 3;
/** Wall-clock backstop — the critic is one bounded call (no CLI call arms a timer otherwise). */
const CRITIC_TIMEOUT_MS = 30_000;

/** Persona — delivered via the agents JSON block (claude has no inline system-prompt flag). */
const CRITIC_SYSTEM_PROMPT =
  'You are an adversarial plan critic for a multi-agent orchestrator. You review a ' +
  'PLAN — an ordered list of agent rows (role + name + task) — BEFORE any agent runs, ' +
  'and surface problems while they are still cheap to fix. You never write code or edit ' +
  'files; you only critique. Be specific and terse. Default to silence: flag genuine ' +
  'issues, not style preferences. Output exactly one fenced `orchestrator-critique` JSON ' +
  'block and nothing else.';

function buildPrompt(rows: PlanRow[], projectId: string): string {
  const roleTools = AGENT_ROLE_ORDER.map(
    (r) => `- ${ROLES[r].label} (${r}): [${resolveTools(r, projectId).join(', ')}]`,
  ).join('\n');
  return [
    'Critique this orchestrator plan for problems the user should see before spawning the fleet. Look for:',
    '1. MISSING ROLES — a risky/substantial change (new code, schema/auth/payments, deletions) with no qa and/or security row to verify it.',
    '2. WRONG ORDERING — a row depending on a later row\'s output; verification placed before the work it checks.',
    '3. MIS-SCOPED TASKS — a task too vague to action, or one row doing the work of several.',
    "4. TOOL ALLOW-LISTS — a row whose role can't accomplish its task with the tools that role is allowed (see allow-lists below).",
    '',
    'Each agent role and the tools it is allowed to use:',
    roleTools,
    '',
    'The plan (JSON array of rows; `i` is the stable row id you must reference in row_findings):',
    '```json',
    JSON.stringify(rows, null, 2),
    '```',
    '',
    'Respond with EXACTLY ONE fenced block, no prose around it:',
    '```orchestrator-critique',
    '{"row_findings":[{"i":<row id>,"severity":"info|warn|error","issue":"<short>"}],"plan_findings":[{"severity":"info|warn|error","issue":"<short>"}]}',
    '```',
    'Use `error` for issues likely to make the run fail or ship unverified/unsafe changes, `warn` for likely-suboptimal, `info` for minor notes. If the plan is sound, return empty arrays.',
  ].join('\n');
}

export async function runPlanCritic(opts: {
  projectId: string;
  rows: PlanRow[];
  env: Record<string, string | undefined>;
  provider: Provider;
  controller: AbortController;
}): Promise<PlanCritique | null> {
  if (opts.provider === 'codex') return null; // claude-first
  if (opts.rows.length < CRITIC_MIN_ROWS) return null;
  if (opts.controller.signal.aborted) return null;

  const { model, betas } = resolveModel(cheapestModelForProvider(opts.provider));
  const prompt = buildPrompt(opts.rows, opts.projectId);

  const timer = setTimeout(() => opts.controller.abort(), CRITIC_TIMEOUT_MS);
  try {
    const q = runClaudeQuery({
      cwd: app.getPath('userData'),
      env: opts.env,
      prompt,
      abortController: opts.controller,
      agent: 'critic',
      effort: 'low',
      agents: {
        critic: {
          description: 'Plan critic — adversarially reviews the plan before spawn.',
          prompt: CRITIC_SYSTEM_PROMPT,
          tools: [] as string[],
          model,
          effort: 'low',
        },
      },
      betas,
    });

    let buf = '';
    for await (const event of q) {
      if (opts.controller.signal.aborted) return null;
      const ev = event as { type: string; [k: string]: unknown };
      if (ev.type === 'assistant') {
        const message = ev.message as { content?: unknown[] } | undefined;
        for (const raw of message?.content ?? []) {
          if (raw == null || typeof raw !== 'object' || !('type' in raw)) continue;
          const block = raw as { type: string; text?: string };
          if (block.type === 'text' && typeof block.text === 'string') buf += block.text;
        }
      } else if (ev.type === 'result') {
        const result = ev as unknown as { is_error?: boolean; subtype?: string };
        if (result.is_error || (result.subtype && result.subtype !== 'success')) {
          return null;
        }
      }
    }
    return extractCritique(buf);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
