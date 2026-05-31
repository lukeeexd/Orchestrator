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

/**
 * Reasoning effort levels the `claude` CLI's `--effort` flag accepts.
 * Default is 'high'. (An `ultracode` tier was briefly added in v0.23.0
 * but removed in v0.23.1 — CLI v2.1.x rejects it; revisit if a future
 * CLI adds it to the accepted enum.)
 */
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
   * F14: when true AND the workspace is a git repo, accepting a plan
   * checks out a fresh `orchestrator/<planId>-<slug>` branch before
   * the first agent spawns. Skipped silently when the workspace
   * isn't a git repo, and skipped-with-warning when there are
   * uncommitted changes (we never overwrite the user's work). Off
   * by default to preserve pre-F14 behaviour.
   */
  autoBranch?: boolean;
  /**
   * N3: a deterministic verification command run once after an auto-mode
   * plan finishes (e.g. `npm test`, `npx tsc --noEmit`). Exit 0 = pass;
   * non-zero = fail → the Director redirects the last agent with the
   * captured output to fix it, re-checks (capped), then surfaces + stops.
   * Empty / undefined = gate off (the default). Runs in the workspace.
   */
  gateCommand?: string;
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

/**
 * N18: one measured slice of what the orchestrator injects into an
 * agent's system prompt at spawn. Token counts are estimates (chars/4,
 * no tokenizer dep) — treat them as "≈".
 */
export interface ContextSegment {
  /** Display label, e.g. 'Base role prompt', 'Project memory'. */
  label: string;
  /** Estimated tokens (chars/4 heuristic). */
  tokens: number;
  /** Exact UTF-8 byte length of the segment text. */
  bytes: number;
  /** Optional one-line hint — where it comes from / how to trim it. */
  hint?: string;
}

/**
 * A component the orchestrator hands off to the CLI by reference (a path
 * or config), so its real token cost is loaded CLI-side and not
 * measurable here. Surfaced for awareness, never counted in the total.
 */
export interface ContextNote {
  label: string;
  detail: string;
}

/**
 * N18: an on-demand breakdown of everything the orchestrator injects
 * into an agent's system prompt at spawn, by source. This is NOT the
 * deleted always-on runtime cost/usage meter — it measures the static
 * prompt the app assembles itself (the one thing it can measure
 * precisely), so you can spot and trim bloat (a heavy MEMORY.md, a long
 * project skill) before it rides every spawn.
 */
export interface ContextBreakdown {
  segments: ContextSegment[];
  /** Sum of segment tokens — the injected, measurable total. */
  totalTokens: number;
  /** Sum of segment bytes. */
  totalBytes: number;
  /** Model context window in tokens, or null when the id is unknown. */
  contextWindow: number | null;
  /** Informational, uncounted (CLI-loaded) components. */
  notes: ContextNote[];
}

/** Request payload for the context-breakdown query (fields the renderer already holds). */
export interface ContextBreakdownRequest {
  projectId: string;
  role: AgentRole;
  subtype?: AgentSubtype;
  model: string;
  /** The agent's provider override (undefined → project default). */
  provider?: Provider;
  /** The agent's task text — measured as its own segment. */
  task: string;
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

/**
 * N7 Plan Critic: an advisory, second-model review of a plan emitted before
 * any agent spawns. `row_findings` target a specific plan row by its stable
 * `PlanRow.i`; `plan_findings` are whole-plan issues (e.g. a risky change with
 * no qa/security row). Severity drives the PlanCard badge colour. Advisory
 * only — never blocks spawning or edits the plan.
 */
export type CritiqueSeverity = 'info' | 'warn' | 'error';
export interface PlanCritique {
  row_findings: Array<{ i: number; severity: CritiqueSeverity; issue: string }>;
  plan_findings: Array<{ severity: CritiqueSeverity; issue: string }>;
}

/**
 * N8: a clarifying question the Director asks in auto mode when a task is too
 * ambiguous to plan well. The user answers in a Q&A card; the answers fold
 * back into the next Director turn, which then emits a grounded plan. Distinct
 * from PRD mode's static `open_questions` (those don't fold back).
 */
export interface ClarifyingQuestion {
  question: string;
  /** Why the answer matters — what it changes about the plan. */
  why: string;
}

/**
 * N9: the Director's self-reported confidence in a plan it just emitted,
 * plus the 1–3 ambiguities driving any uncertainty. A hint that informs
 * the existing confirm-before-spawn — uncalibrated, never blocks. Distinct
 * from N7's external Plan Critic (adversarial review) and N8's pre-plan
 * questions (which fold back before a plan exists); these are the
 * assumptions the Director chose to plan *around* rather than ask about.
 */
export interface PlanConfidence {
  /** 0–100 self-assessed likelihood the plan succeeds as scoped. Uncalibrated. */
  score: number;
  /** The 1–3 assumptions the plan rests on (what, if wrong, would change it). */
  ambiguities: string[];
}

/**
 * N6 — run-scoped blackboard. One entry per agent completion during an
 * accepted-plan run, capturing the structured evidence the agent left behind.
 * The durable storage layer behind the N5 progress ledger: persisted per
 * `runId` (= the accepted plan's DirectorMessage id) so the ledger survives an
 * app restart and a future "inject accumulated artifacts into the next agent"
 * pass has something concrete to read. Field shapes mirror `HandoffPayload`
 * (already size-capped in `handoffPayload.ts`).
 */
export interface BlackboardEntry {
  id: string;
  projectId: string;
  /** = the accepted plan's DirectorMessage id; groups entries into one run. */
  runId: string;
  agentId: string;
  agentName: string;
  role: AgentRole;
  ts: number;
  summary: string;
  filesTouched: string[];
  testsRun: TestsRunSummary | null;
  errors: string[];
  todos: string[];
}

export type LedgerRowStatus = 'pending' | 'active' | 'done' | 'failed';

/**
 * N5 — one row of the progress ledger, derived from a PlanRow plus the
 * blackboard entry of the agent that ran it. `evidence` is attached once the
 * row's agent has completed.
 */
export interface LedgerRow {
  i: number;
  role: AgentRole;
  name: string;
  task: string;
  status: LedgerRowStatus;
  evidence?: {
    filesTouched: number;
    testsRun: TestsRunSummary | null;
    errors: number;
    summary?: string;
  };
}

/**
 * N5 — the Task + Progress Ledger for one accepted-plan run. A derived view
 * (the plan rows + accumulated blackboard evidence) that rides on the plan's
 * DirectorMessage as `ledger?` — so it persists and pushes live to the renderer
 * over the same patch→broadcast path as `critique`/`confidence`, no separate
 * channel. `stallCount` is a deterministic count of consecutive no-progress
 * steps; at `STALL_LIMIT` the run is paused and surfaced (NOT auto-replanned —
 * that risky half is deferred, gated on a session-wide budget cap).
 */
export interface RunLedger {
  runId: string;
  rows: LedgerRow[];
  /** Consecutive no-progress steps (reset by any productive step). */
  stallCount: number;
  /** True once `stallCount >= STALL_LIMIT` — the run was paused for review. */
  stalled: boolean;
  /** Human-readable reason shown on the card when `stalled`. */
  pausedReason?: string;
  /** PRE-2a: director-driven agent spawns recorded for this run so far. */
  spawnCount: number;
  /** PRE-2a: the run's spawn cap (the `maxSpawnsPerRun` setting). 0 = unlimited. */
  spawnCap: number;
  /** PRE-2a: true once `spawnCount >= spawnCap > 0` — the run hit its cap and halted. */
  capped: boolean;
  /** Human-readable reason shown on the card when `capped`. */
  cappedReason?: string;
  updatedAt: number;
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
  /** N7: advisory Plan Critic findings, attached to a plan message before spawn. */
  critique?: PlanCritique;
  /** N8: clarifying questions the Director asks (auto mode) instead of a plan. */
  questions?: ClarifyingQuestion[];
  /** N9: self-reported confidence + driving ambiguities, attached to a plan message. */
  confidence?: PlanConfidence;
  /** N5: live Task/Progress ledger for the run this (accepted) plan kicked off. */
  ledger?: RunLedger;
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

/**
 * F12: per-log-line note. The renderer fetches the full list for an
 * agent on select and indexes by `lineKey` for O(1) lookup during
 * the log-line render pass. lineKey is the FNV-1a hex of
 * (ts + kind + msg) — see `src/shared/logNotes.ts`.
 */
export interface LogNote {
  lineKey: string;
  body: string;
  createdAt: number;
  updatedAt: number;
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
