import type {
  Agent,
  AgentRole,
  AgentSubtype,
  LogLine,
} from '../../shared/types';
import { ROLES } from '../../shared/roles';
import * as registry from './registry';
import { effectiveSkill } from '../skills';
import { getProject } from '../projects';
import { getSecretsForSpawn } from '../secrets';
import { awaitCompletion as awaitLockedCompletion } from './agent-lock';

/**
 * P10: Flavour-specific prompt blocks appended to a role's base
 * system prompt. Today only qa.playwright is wired — adding a new
 * flavour means dropping a key here + extending AgentSubtype in
 * shared/types.ts.
 *
 * The instruction to emit `Tests: N passed / M total` on the final
 * line is what the AgentRow's KPI chip parser scans for, so changing
 * the wording here means changing the regex in
 * `parseTestsKpi` (src/renderer/components/AgentRow.tsx) too.
 */
const SUBTYPE_PROMPTS: Partial<
  Record<AgentRole, Partial<Record<AgentSubtype, string>>>
> = {
  qa: {
    playwright: `## Playwright mode

This workspace is expected to use Playwright for browser/Electron e2e tests.

- Locate the Playwright config (\`playwright.config.{ts,js,mjs}\`). If none exists, scaffold a minimal one before adding tests.
- Run tests with \`npx playwright test --reporter=line\` to keep output compact.
- When debugging a flake, prefer \`--repeat-each\` over re-running the whole suite.

When your run finishes, emit a single final line of the form:

  Tests: <passed> passed / <total> total

(Example: \`Tests: 14 passed / 16 total\`.) The orchestrator parses this line into a KPI chip on the agent row, so the format matters — emit it verbatim, on its own line, exactly once.`,
  },
};

/**
 * Private helpers shared across the runner's spawn / fork / redirect /
 * abort / query modules. None of these are part of the runner's public
 * surface; `runner.ts` is the barrel that re-exports only what other
 * layers need.
 */

/**
 * Universal "how to propose memory" block. Appended to every role's
 * system prompt by `buildSystemPromptFor`. Teaches the agent to emit
 * an `orchestrator-memory` fenced JSON block when it discovers
 * something worth pinning for future spawns of this role.
 *
 * The body of each block lands as a pending proposal in the
 * `memory_proposals` table; the user approves or rejects from the
 * Drawer's Memory tab; approved bodies are appended to the
 * project's per-role skill file, which `effectiveSkill` already
 * surfaces above on every future spawn.
 *
 * Keep the format aligned with the parser
 * (`src/main/agents/memoryParse.ts`) — the fenced-block tag MUST be
 * `orchestrator-memory`; changing it here means changing the regex
 * there too.
 */
const PROPOSE_MEMORY_PROMPT = `## Proposing memory for future agents

If you discover something genuinely worth remembering about *this project* — a non-obvious constraint, a convention that future agents of your role should know, a gotcha that cost you time — propose it for memory by emitting a fenced block in your final message:

\`\`\`orchestrator-memory
<short, self-contained text that any future agent of this role should know>
\`\`\`

The user reviews each proposal from the Memory tab. Approved bodies are appended to this project's per-role prompt; the next time a fresh agent of your role spawns, they'll see your note before they start work.

When to propose:
- "We use sql.js (not better-sqlite3) because no MSVC toolchain is available locally."
- "The marketplace module was split into focused submodules in v0.10.0 — don't read marketplace.ts."
- "Auto-update polls Cloudflare R2 in v0.15.0+, not update.electronjs.org."

When NOT to propose:
- Notes about *this specific run* (those belong in your final summary, not in memory).
- Restating what's already in CLAUDE.md or the role's existing prompt.
- Vague observations ("the code is complex"). Memory pins should be actionable.

Emit at most one or two memory blocks per run. Each is a long-term commitment to future spawns — be selective.`;

/**
 * Build the role's effective system prompt: its hardcoded prompt plus
 * any per-role skill body the project has authored (or the in-app
 * default) plus the flavour-specific block when an AgentSubtype is
 * set plus the universal "propose memory" instructions. Empty skill
 * content is a no-op.
 */
export function buildSystemPromptFor(
  role: AgentRole,
  projectId: string,
  subtype?: AgentSubtype,
): string {
  const base = ROLES[role].systemPrompt;
  const skill = effectiveSkill(projectId, role).trim();
  const flavour = subtype ? (SUBTYPE_PROMPTS[role]?.[subtype] ?? '').trim() : '';
  const parts = [base];
  if (skill) parts.push(`## Project skill\n\n${skill}`);
  if (flavour) parts.push(flavour);
  parts.push(PROPOSE_MEMORY_PROMPT);
  return parts.join('\n\n');
}

/**
 * Resolve the tool allow-list for an agent: per-project role override
 * (if any) wins over the role's hardcoded default. Used by both initial
 * spawn and fork; redirects already inherit their parent's allow-list
 * via the registry's stored agent definition, so they pass through
 * unchanged.
 */
export function resolveTools(role: AgentRole, projectId: string): string[] {
  const project = getProject(projectId);
  const override = project?.roleTools?.[role];
  return override && override.length > 0 ? override : ROLES[role].tools;
}

export interface AuthSettings {
  apiKey: string;
  oauthToken: string;
  defaultModel: string;
}

export function buildEnv(
  settings: AuthSettings,
  projectId?: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (settings.oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = settings.oauthToken;
    delete env.ANTHROPIC_API_KEY;
  } else if (settings.apiKey) {
    env.ANTHROPIC_API_KEY = settings.apiKey;
  }
  // F6: layer project secrets on top so the agent's shell sees
  // DATABASE_URL / GH_TOKEN / etc. as regular env vars. Values are
  // passed verbatim — shell:false in spawn means no metacharacter
  // interpolation; the child process gets clean strings.
  //
  // Project secrets WIN over inherited process.env vars of the same
  // name: that lets a user override a globally-set DATABASE_URL with
  // a per-project one without unsetting the global first.
  if (projectId) {
    const secrets = getSecretsForSpawn(projectId);
    for (const [k, v] of Object.entries(secrets)) {
      env[k] = v;
    }
  }
  return env;
}

export interface RunnerSinks {
  onAgent: (agent: Agent) => void;
  onLog: (agentId: string, line: LogLine) => void;
  onPatch: (agentId: string, patch: Partial<Agent>) => void;
}

/**
 * Mint the next agent name within a project. Walks the registry for
 * existing names matching `<prefix>-NN` and returns one higher.
 * Researchers get `research-NN` rather than `researcher-NN` because
 * the shorter form fits the agent list better.
 */
export function nextName(role: AgentRole, projectId: string): string {
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

export function elapsed(startedAt: number): string {
  const total = Math.floor((Date.now() - startedAt) / 1000);
  const m = Math.floor(total / 60)
    .toString()
    .padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/**
 * Returns a promise that resolves when the given agent reaches a
 * terminal status (done | error | aborted). Already-completed agents
 * resolve immediately.
 *
 * Backed by the generation-tagged tracker in `agent-lock.ts` so a
 * redirect or fork replacing the in-flight entry doesn't trip the
 * earlier cleanup timer.
 */
export function awaitCompletion(agentId: string): Promise<void> {
  return awaitLockedCompletion(agentId);
}

/**
 * Per-second tick: updates the agent's elapsed display and clears
 * itself when the agent leaves the registry. Returns the interval
 * handle so the caller (run / runFork / runRedirect) can clear it on
 * its own finally-block too.
 */
export function startElapsedTimer(
  agentId: string,
  sinks: RunnerSinks,
  /**
   * When this turn's clock started. Defaults to the agent's spawn time
   * (`startedAt`) — correct for spawn + fork. A redirect resumes an agent
   * that may have sat idle (done) for a long time, so it passes the redirect
   * moment instead; otherwise elapsed would count the idle gap (a "done at
   * 00:06 → 12:46 on redirect" jump). `startedAt` itself is left untouched so
   * canvas/history ordering by spawn time is preserved.
   */
  since?: number,
): NodeJS.Timeout {
  const elapsedTimer = setInterval(() => {
    const e = registry.get(agentId);
    if (!e) {
      clearInterval(elapsedTimer);
      return;
    }
    const next = elapsed(since ?? e.agent.startedAt);
    if (next !== e.agent.elapsed) {
      registry.patch(agentId, { elapsed: next });
      sinks.onPatch(agentId, { elapsed: next });
    }
  }, 1000);
  return elapsedTimer;
}

/**
 * Terminal-status set covers the post-abort patch states. Once an
 * agent reaches one of these, consumeQuery must stop draining the
 * CLI tail — otherwise a buffered `result` event arriving after a
 * budget abort overwrites "Budget exceeded" with the CLI's generic
 * is_error subtype.
 */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'done',
  'error',
  'aborted',
]);

/**
 * H5: in-memory cap on `agent.log`. The persistence layer keeps the
 * full history on disk; the Drawer's Logs tab pulls older slices on
 * demand via persistence.listLogLinesForAgent. Without the cap a
 * long-running chatty agent grows its array unbounded and
 * `registry.listForProject` serialises the whole thing over IPC on
 * every renderer mount.
 *
 * 2000 lines is well above the Drawer's last-8 view + roughly one or
 * two assistant turns' worth of tool calls. The boundary is fuzzy by
 * design — losing the oldest line off the in-memory tail isn't a
 * correctness issue because the disk has it.
 */
export const LOG_TAIL_CAP = 2000;
