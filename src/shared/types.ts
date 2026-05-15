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
  worktreePath: string | null;
  log: LogLine[];
  startedAt: number;
}

export interface SpawnAgentRequest {
  role: AgentRole;
  task: string;
  workspace: string;
}

export interface SpawnAgentResponse {
  ok: true;
  agentId: string;
}
