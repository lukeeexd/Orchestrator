export type AgentRole = 'pm' | 'researcher' | 'coder' | 'qa' | 'devops' | 'security';

/**
 * Optional flavour within an AgentRole. Currently only `qa` uses one
 * — 'playwright' adds Playwright-specific guidance to the system
 * prompt and unlocks the "Tests: N/M" KPI chip on the agent row.
 * Field stays generic so other roles can grow flavours later (e.g.
 * a `coder.refactor` subtype) without another migration.
 */
export type AgentSubtype = 'playwright';

/**
 * What kinds of "actor" can have a skill prompt attached. Agent roles
 * plus the Director — the Director isn't an AgentRole (it's a separate
 * concept), but it has the same on-disk SKILL.md slot.
 */
export type SkillKey = AgentRole | 'director';

export type AgentStatus =
  | 'running'
  | 'waiting'
  | 'approval'
  | 'paused'
  | 'aborted'
  | 'done'
  | 'error';

export type LogKind =
  | 'thought'
  | 'tool'
  | 'result'
  | 'warn'
  | 'error'
  | 'note'
  | 'handoff';

export interface ToolCall {
  fn: string;
  args: { k: string; v: string }[];
}

export interface LogLine {
  ts: string;
  kind: LogKind;
  msg: string | ToolCall;
}

/** Reasoning effort levels supported by the Agent SDK. Default is 'high'. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Which agent CLI to spawn. Default 'claude' — the original runtime.
 * 'codex' uses OpenAI's Codex CLI (`codex exec --json`) instead. The two
 * speak slightly different JSONL event shapes; the runner normalises
 * codex events into claude-shaped ones so consumeQuery doesn't care.
 */
export type Provider = 'claude' | 'codex';

export interface Project {
  id: string;
  name: string;
  workspace: string;
  createdAt: number;
  /** Which CLI backend the project's Director + agents run against. Defaults to 'claude'. */
  provider: Provider;
  /** Per-project override for the Director's model. Falls back to settings.defaultModel. */
  directorModel?: string;
  /** Per-project override for the Director's reasoning effort. Falls back to settings.defaultEffort. */
  directorEffort?: EffortLevel;
  /**
   * Per-project override for the Director's provider. Lets the Director
   * run on a different CLI than the agents — e.g. claude Director
   * orchestrating mostly-codex specialists. Undefined → Director uses
   * the project's main `provider` field, same as before this existed.
   */
  directorProvider?: Provider;
  /**
   * Project-level MCP server config, stored verbatim as the JSON the
   * `claude --mcp-config` flag accepts (typically `{"mcpServers": {...}}`).
   * Empty / undefined → no extra MCP servers, the spawn skips
   * `--mcp-config` entirely. Codex spawns ignore this — codex exec has
   * no equivalent flag. Mirrored to disk under userData/mcp-configs/
   * so the CLI can read it from a file path instead of taking the
   * whole JSON over argv.
   */
  mcpConfig?: string;
  /**
   * Per-role tool allow-list overrides. Keys are AgentRole values; values are
   * the tools that role is permitted in this project. Roles not present in
   * the map fall back to the role's default tool set from `shared/roles.ts`.
   *
   * Only honored when provider === 'claude'. Codex uses sandbox-policy
   * scopes (read-only / workspace-write / danger-full-access) instead of
   * named tool allowlists, so the grid is hidden for codex projects.
   */
  roleTools?: Partial<Record<AgentRole, string[]>>;
}

export type AgentSpawnedBy = 'user' | 'director';

export interface AgentBudget {
  usd: number;
  tokens: number;
  seconds: number;
}

export interface Agent {
  id: string;
  projectId: string;
  role: AgentRole;
  /**
   * Optional flavour within the role — set at spawn time, never
   * changes after. Today only `qa` uses it (value 'playwright'). The
   * renderer reads it to render a flavour pill on the agent row, and
   * `buildSystemPromptFor` reads it to append the flavour's prompt
   * block. Undefined means "default flavour for this role".
   */
  subtype?: AgentSubtype;
  roleLabel: string;
  name: string;
  status: AgentStatus;
  statusLabel: string;
  step: string;
  task: string;
  tokens: number;
  cost: number;
  elapsed: string;
  model: string;
  effort: EffortLevel;
  /**
   * Per-agent provider override. When undefined the agent uses its
   * project's provider — same behaviour as before this field existed.
   * Set at spawn time and never changes after; switching mid-run
   * doesn't make sense (the CLI session is bound to one provider).
   */
  provider?: Provider;
  /**
   * Per-model spend breakdown — captured from each CLI result event's
   * modelUsage field and merged cumulatively across the agent's run +
   * any subsequent redirects/forks. Lets the UI show which model
   * actually burned the $ (often a mix of the chosen agent.model + a
   * cheaper auxiliary model used internally by the CLI). Optional
   * because pre-v0.5 agents in the DB don't have it.
   */
  modelUsage?: Record<string, { tokens: number; cost: number }>;
  workspace: string;
  budget: AgentBudget;
  spawnedBy: AgentSpawnedBy;
  log: LogLine[];
  startedAt: number;
  /**
   * F8: wall-clock end time. Set on every transition to a terminal
   * status (done / error / paused); cleared when the agent is
   * redirected back to running. Older rows are backfilled in
   * migration v25 from `started_at + parse(elapsed)` on a best-
   * effort basis. Undefined means "still running" (or "in-progress
   * across an app restart").
   */
  endedAt?: number;
  /** SDK session id, captured from the stream. Enables Redirect via `options.resume`. */
  sessionId?: string;
  /** Set when this agent was forked off another. Stored for UX attribution. */
  forkedFromId?: string;
  forkedFromName?: string;
}

export interface ForkAgentRequest {
  /** Parent agent id — its conversation history is the seed for the fork. */
  parentAgentId: string;
  /** Instruction to send into the forked session. Required — fork without a new direction is just a duplicate. */
  task: string;
  /** Override the model. Falls back to the parent's model. */
  model?: string;
  /** Override the reasoning effort. Falls back to the parent's effort. */
  effort?: EffortLevel;
  attachments?: string[];
}

export interface RedirectAgentRequest {
  agentId: string;
  body: string;
  /** Override the model for this turn (and going forward). Falls back to agent's existing model. */
  model?: string;
  /** Override the reasoning effort for this turn (and going forward). Falls back to agent's existing effort. */
  effort?: EffortLevel;
  attachments?: string[];
}

export interface PlanRow {
  i: number;
  role: AgentRole;
  name: string;
  task: string;
  /**
   * Optional per-row provider override. When set, the auto-spawned
   * agent runs against this CLI instead of the project's default.
   * Lets the Director compose mixed-provider plans — e.g. claude for
   * orchestration-heavy or vision-driven rows, codex for cheap fast
   * specialists. Undefined → use the project's provider.
   */
  provider?: Provider;
}

/**
 * Director's three operating modes:
 *   - `auto`   — Director emits `orchestrator-plan` blocks; the renderer
 *                auto-spawns the fleet the moment a turn lands.
 *   - `manual` — Director acts as an advisor; the user spawns agents
 *                from the workspace pane.
 *   - `prd`    — Director reads the workspace and emits an
 *                `orchestrator-prd` block (problem / goals / non-goals /
 *                constraints / open-questions) instead of a plan. Useful
 *                for inherited projects where the brief isn't fully
 *                formed yet. No spawning; the block renders as a
 *                copy-to-clipboard PRDCard. (P15.)
 */
export type DirectorMode = 'auto' | 'manual' | 'prd';

/**
 * Structured product-requirements doc emitted by the Director in
 * `[mode: prd]`. All fields except `problem` are arrays so an empty
 * section is "no items" rather than "missing data".
 */
export interface ProjectPrd {
  /** Optional one-line headline. */
  title?: string;
  /** Required — what's the user actually trying to solve. */
  problem: string;
  /** Concrete deliverables the project must hit. */
  goals: string[];
  /** Things deliberately out of scope (helps reviewers spot drift). */
  non_goals: string[];
  /** Tech / org constraints to honour (budgets, dependencies, deadlines). */
  constraints: string[];
  /** Unresolved questions for the user to answer before scoping. */
  open_questions: string[];
}

export type DirectorWho = 'user' | 'director' | 'system';

/**
 * A reusable Director plan. Surfaced in the Templates rail item;
 * picking one synthesises a plan message so the existing PlanCard
 * editor handles spawn / edit / drop rows the same way as a
 * Director-emitted plan.
 */
export interface Template {
  id: string;
  name: string;
  description: string;
  /** Director mode the template was authored against — hint only; the user can change mode before spawning. */
  mode: DirectorMode;
  /** Short labels for filtering ("refactor", "tdd", "security", "onboarding", …). */
  tags: string[];
  /** PlanRow[] the runner spawns when the user accepts. */
  rows: PlanRow[];
  /** True for the four seeded defaults — the UI hides delete on these. */
  builtin: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AttachmentRef {
  path: string;
  name: string;
}

export interface RedirectInstruction {
  agent: string;
  instruction: string;
}

export interface DirectorMessage {
  id: string;
  projectId: string;
  who: DirectorWho;
  name: string;
  time: string;
  body: string;
  plan?: PlanRow[];
  planAccepted?: boolean;
  redirect?: RedirectInstruction;
  redirectFired?: boolean;
  /** P15: PRD emitted by the Director in `[mode: prd]`. Renderer shows it as a PRDCard. */
  prd?: ProjectPrd;
  live?: boolean;
  attachments?: AttachmentRef[];
}

export interface SpawnAgentRequest {
  projectId: string;
  role: AgentRole;
  /**
   * Optional role flavour. The renderer's spawn form surfaces a
   * picker for roles that have flavours defined (today: `qa` →
   * 'playwright'). Other role+subtype combos are ignored — the
   * agent runs as the role's default flavour.
   */
  subtype?: AgentSubtype;
  task: string;
  workspace: string;
  /** Override the model the agent runs on. Falls back to settings.defaultModel. */
  model?: string;
  /** Override the reasoning effort. Falls back to settings.defaultEffort. */
  effort?: EffortLevel;
  /**
   * Override the CLI backend for this single agent. Falls back to the
   * project's provider when undefined. Lets a claude-default project
   * spawn a codex specialist, or vice versa.
   */
  provider?: Provider;
  spawnedBy?: AgentSpawnedBy;
  budget?: Partial<AgentBudget>;
  attachments?: string[];
}

// SpawnAgentResponse lives in shared/ipc.ts — keeping the IPC
// surface in one place. The earlier duplicate here was never
// imported but drifted independently when ipc.ts gained the
// `ok: true` literal.

export interface SpendBucket {
  /** Display label for the bucket (project name, model id, or role label). */
  label: string;
  /** Stable id — used by the renderer for keys and for "drill in" later. */
  id: string;
  agentCount: number;
  tokens: number;
  cost: number;
}

export interface SpendAgentRow {
  id: string;
  name: string;
  role: AgentRole;
  model: string;
  status: AgentStatus;
  projectId: string;
  projectName: string;
  cost: number;
  tokens: number;
  startedAt: number;
}

export interface HistoryRow {
  id: string;
  name: string;
  role: AgentRole;
  roleLabel: string;
  status: AgentStatus;
  statusLabel: string;
  model: string;
  task: string;
  tokens: number;
  cost: number;
  startedAt: number;
  /** F8: see Agent.endedAt. Null for still-running rows. */
  endedAt: number | null;
  elapsed: string;
  projectId: string;
  projectName: string;
  spawnedBy: AgentSpawnedBy;
  forkedFromName?: string;
}

export interface SpendDayBucket {
  /** Local-time YYYY-MM-DD. Days with zero spend are included as gap-fillers. */
  date: string;
  agentCount: number;
  tokens: number;
  cost: number;
}

/**
 * F6: per-project secret metadata returned to the renderer. Values
 * are deliberately omitted from the bulk-list response so a casual
 * log of the IPC payload can't leak the vault.
 */
export interface SecretListEntry {
  name: string;
  updatedAt: number;
  /** Length of the stored value — lets the UI render `••• (12)` without revealing the bytes. */
  valueLength: number;
}

export interface SpendSummary {
  /** Aggregate totals across every agent in every project — lifetime. */
  lifetime: { agentCount: number; tokens: number; cost: number };
  /** Same totals filtered to agents started in the trailing 7 days. */
  last7d: { agentCount: number; tokens: number; cost: number };
  /** Same totals filtered to agents started in the trailing 30 days. */
  last30d: { agentCount: number; tokens: number; cost: number };
  /** One row per project, sorted by cost descending. */
  byProject: SpendBucket[];
  /** One row per model (as stored on the agent), sorted by cost descending. */
  byModel: SpendBucket[];
  /** One row per role, sorted by cost descending. */
  byRole: SpendBucket[];
  /** Trailing 30 days, one entry per day, ascending. Zero-spend days included so the chart doesn't have gaps. */
  byDay: SpendDayBucket[];
  /** Top 20 most expensive agents, all-time. */
  topAgents: SpendAgentRow[];
}

/**
 * F7: pre-spawn cost forecast for a PlanCard. Per-role medians come
 * from completed agents in the agents table. We don't try to model
 * task-length or model-selection adjustments yet — the median alone
 * is a useful "have I been burned by a 5-agent Opus run before"
 * signal. ±50% band approximates the variance band wide enough that
 * the user reads it as "ballpark" rather than "promise".
 */
export interface PlanCostForecast {
  /** Lower bound of the forecast band, USD. Zero on no-history. */
  lowUsd: number;
  /** Upper bound of the forecast band, USD. Zero on no-history. */
  highUsd: number;
  /** Midpoint (sum of per-role medians), USD. Zero on no-history. */
  midUsd: number;
  /**
   * `history` — every row's role has at least 3 completed samples.
   * `partial` — at least one row's role has < 3 samples; estimate
   *             uses what we have and notes the gap.
   * `no-history` — no rows could be priced; renderer shows "no history".
   */
  basis: 'history' | 'partial' | 'no-history';
  /** Per-role breakdown for tooltip display. */
  perRole: Array<{
    role: AgentRole;
    /** How many completed samples this median is based on. */
    sampleCount: number;
    /** Per-row median used in the sum, USD. */
    medianUsd: number;
    /** How many plan rows this role contributes. */
    rowCount: number;
  }>;
}

/**
 * One rule-based recommendation surfaced on the Spend screen.
 * Recomputed every time the user opens the rail; no persistent
 * "dismissed" state in v1 (the underlying conditions resolving is the
 * dismiss signal — e.g. unsubscribing the idle bundle removes the
 * card on next load).
 */
export interface SpendRecommendation {
  /** Stable id — used as a React key and as a hook for future dismiss state. */
  id: string;
  /** Visual weight: 'info' for FYI, 'warn' for "you probably want to look at this". */
  severity: 'info' | 'warn';
  /** One-line headline shown in the card. */
  title: string;
  /** Two-or-three-sentence explanation + suggested action. */
  body: string;
  /** Optional rail item id to deep-link to (history / marketplace / settings / tools). */
  deepLink?: 'settings' | 'marketplace' | 'tools' | 'history';
}

/**
 * Self-improving-loadout nudge for the Marketplace screen. Each insight
 * carries an optional in-place action — usually a narrower selectedSkills
 * value the renderer can apply via the existing setMarketplaceBundleSkills
 * IPC without a new write path.
 */
export interface LoadoutInsight {
  id: string;
  severity: 'info' | 'warn';
  title: string;
  body: string;
  action?: LoadoutInsightAction;
}

/**
 * P7 — one entry per audited skill that triggered at least one
 * pattern match. Empty findings → skill omitted from the report
 * (clean skills are implied by the bundle count vs report count).
 */
export interface SkillAuditReport {
  sourceId: string;
  bundleId: string;
  skillId: string;
  /** Human label from frontmatter `name:`, falls back to skill id. */
  skillName: string;
  /** Highest severity across this skill's findings — drives the badge. */
  worstSeverity: SkillAuditFinding['severity'];
  findings: SkillAuditFinding[];
}

export interface SkillAuditFinding {
  /** Pattern id ("net-curl", "cred-keychain", etc) for stable refs. */
  patternId: string;
  category: 'network' | 'credentials' | 'fs-escape' | 'eval';
  severity: 'red' | 'yellow' | 'green';
  /** One-line explanation surfaced next to the snippet. */
  reason: string;
  /** Representative line (trimmed, capped at 200 chars) that triggered the match. */
  snippet: string;
  /** Line number within SKILL.md, 1-indexed. */
  lineNumber: number;
}

/**
 * Structured-handoff evidence summarising what an agent did before
 * the Director sees the next turn. Computed from the agent's log
 * lines + the CLI's final result message. Embedded as a fenced JSON
 * block in the [handoff] message body so the Director can reason
 * about machine-readable facts rather than parsing prose.
 *
 * All fields are present even when empty (`files_touched: []`,
 * `tests_run: null`, etc) — keeps the JSON shape stable for any
 * downstream consumer.
 */
export interface HandoffPayload {
  /** The agent's final prose summary (the CLI's `result` field). May be empty. */
  summary: string;
  /** Workspace-relative paths the agent wrote to or edited, deduped. */
  files_touched: string[];
  /** Best-effort tally from Bash tool_use + result text. Null when we couldn't infer counts. */
  tests_run: TestsRunSummary | null;
  /** TODO / "next step" / "follow-up" lines the agent surfaced in its own prose. */
  todos: string[];
  /** Errors logged during the run. Up to 5; truncated for readability. */
  errors: string[];
}

export interface TestsRunSummary {
  pass: number;
  fail: number;
  skip: number;
}

/**
 * The single supported action in v1 is "prune the bundle's selectedSkills
 * down to a flat list of skills that have actually fired". Future
 * variants (promote-to-global, reset-to-recommended) would add tagged
 * union members here.
 */
export interface LoadoutInsightAction {
  kind: 'prune-idle-skills';
  /** Identifies the subscription to update. */
  sourceId: string;
  bundleId: string;
  /** Scope: 'global' uses the marketplace sentinel; otherwise a real projectId. */
  scope: string;
  /** Skills to keep — the renderer passes this to setSubscriptionSkills as the flat-list form. */
  keepSkillIds: string[];
  /** Skills that would be removed — surfaced in the button's tooltip / confirmation. */
  pruneSkillIds: string[];
}

/**
 * S5: a captured crash. Written one JSON file per crash to
 * `userData/crashes/` by the main-process handler in
 * `src/main/crashes.ts`. The Settings UI lists the most recent
 * entries; nothing leaves the device unless the user explicitly
 * shares the JSON.
 */
export type CrashKind =
  | 'main-uncaught'
  | 'main-rejection'
  | 'main-child-gone'
  | 'renderer-process-gone'
  | 'renderer-error-boundary';

export interface CrashEntry {
  /** Filesystem basename (timestamp + short uuid). Stable id for "open this one". */
  id: string;
  ts: string;
  kind: CrashKind;
  appVersion: string;
  electronVersion: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  error: {
    name: string;
    message: string;
    stack?: string;
  };
  /** Free-form context — render URL, exit code, component stack, etc. */
  context?: Record<string, unknown>;
}

/**
 * An agent's proposal to add something to its role's persistent memory.
 * Emitted via an `orchestrator-memory` fenced block in the agent's
 * assistant text; landed as a pending proposal until the user
 * approves or rejects via the Drawer's Memory tab.
 *
 * Approval appends `body` to the per-role skill file (P4 storage), so
 * subsequent spawns of that role see the memory through the existing
 * `effectiveSkill` path. No new prompt-loading mechanism — just a new
 * way for the prompt to grow over time.
 */
export type MemoryProposalStatus = 'pending' | 'approved' | 'rejected';

export interface MemoryProposal {
  id: string;
  projectId: string;
  role: AgentRole;
  /** The proposed memory body — appended verbatim to the per-role skill on approve. */
  body: string;
  /** Originating agent — kept after approve/reject for provenance. */
  sourceAgentId?: string;
  sourceAgentName?: string;
  createdAt: number;
  status: MemoryProposalStatus;
}

/**
 * Tree entry for the Docs rail-screen browser. The renderer renders
 * directories (sorted first) + `.md` / `.markdown` files; non-markdown
 * files are filtered out by main-side `markdownBrowser.listDirectory`.
 */
export interface MarkdownDirEntry {
  name: string;
  /** Absolute path on disk — round-trips back to main for navigation / read. */
  path: string;
  isDirectory: boolean;
  /** True for `.md` / `.markdown` files (case-insensitive). */
  isMarkdown: boolean;
}

export interface MarkdownListing {
  /** Absolute path of the directory that was listed. */
  path: string;
  /** Parent's absolute path; null when we're at the filesystem root. */
  parent: string | null;
  entries: MarkdownDirEntry[];
}

export interface MarkdownFileContent {
  path: string;
  content: string;
  /** True if the file exceeded 5 MiB and `content` is a head-of-file slice. */
  truncated: boolean;
}
