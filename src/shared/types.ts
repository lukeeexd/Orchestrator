export type AgentRole = 'pm' | 'researcher' | 'coder' | 'qa' | 'devops';

export type AgentStatus =
  | 'running'
  | 'waiting'
  | 'approval'
  | 'paused'
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

export interface Project {
  id: string;
  name: string;
  workspace: string;
  createdAt: number;
  /** Per-project override for the Director's model. Falls back to settings.defaultModel. */
  directorModel?: string;
  /** Per-project override for the Director's reasoning effort. Falls back to settings.defaultEffort. */
  directorEffort?: EffortLevel;
  /**
   * Per-role tool allow-list overrides. Keys are AgentRole values; values are
   * the tools that role is permitted in this project. Roles not present in
   * the map fall back to the role's default tool set from `shared/roles.ts`.
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
}

export type DirectorMode = 'auto' | 'manual';

export type DirectorWho = 'user' | 'director' | 'system';

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
  spawnedBy?: AgentSpawnedBy;
  budget?: Partial<AgentBudget>;
  attachments?: string[];
}

export interface SpawnAgentResponse {
  ok: true;
  agentId: string;
}

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
