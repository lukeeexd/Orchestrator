export type AgentRole = 'pm' | 'researcher' | 'coder' | 'qa' | 'devops' | 'security';

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

export type DirectorMode = 'auto' | 'manual';

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
  live?: boolean;
  attachments?: AttachmentRef[];
}

export interface SpawnAgentRequest {
  projectId: string;
  role: AgentRole;
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
