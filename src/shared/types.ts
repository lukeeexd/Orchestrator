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

export type AgentSpawnedBy = 'user' | 'director';

export interface AgentBudget {
  usd: number;
  tokens: number;
  seconds: number;
}

export interface Agent {
  id: string;
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
  role: AgentRole;
  task: string;
  workspace: string;
  spawnedBy?: AgentSpawnedBy;
  budget?: Partial<AgentBudget>;
  attachments?: string[];
}

export interface SpawnAgentResponse {
  ok: true;
  agentId: string;
}
