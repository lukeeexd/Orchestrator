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
