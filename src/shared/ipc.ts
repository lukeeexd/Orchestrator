import type {
  Agent,
  DirectorMessage,
  LogLine,
  PlanRow,
  SpawnAgentRequest,
} from './types';

export const IpcChannels = {
  AppPing: 'app:ping',
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  AgentList: 'agent:list',
  AgentSpawn: 'agent:spawn',
  AgentAbort: 'agent:abort',
  AgentPickWorkspace: 'agent:pickWorkspace',
  DirectorList: 'director:list',
  DirectorSend: 'director:send',
  DirectorAcceptPlan: 'director:acceptPlan',
  DirectorAbort: 'director:abort',
  // Renderer-bound streaming events:
  AgentEventAgent: 'agent:event:agent',
  AgentEventLog: 'agent:event:log',
  AgentEventPatch: 'agent:event:patch',
  DirectorEventMessage: 'director:event:message',
  DirectorEventPatch: 'director:event:patch',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];

export interface AppPingResponse {
  ok: true;
  version: string;
  startedAt: number;
}

export interface Settings {
  /** Anthropic Console API key (sk-ant-...). For Pro/Team plans, leave empty and use oauthToken or auto-discovery. */
  apiKey: string;
  /** Long-lived OAuth token from `claude setup-token`. Takes precedence over apiKey when set. */
  oauthToken: string;
  defaultModel: string;
}

export interface SpawnAgentResponse {
  ok: true;
  agentId: string;
}

export interface PickWorkspaceResponse {
  path: string | null;
}

export interface AgentEventAgentPayload {
  agent: Agent;
}

export interface AgentEventLogPayload {
  agentId: string;
  line: LogLine;
}

export interface AgentEventPatchPayload {
  agentId: string;
  patch: Partial<Agent>;
}

export interface DirectorEventMessagePayload {
  message: DirectorMessage;
}

export interface DirectorEventPatchPayload {
  id: string;
  patch: Partial<DirectorMessage>;
}

export interface AcceptPlanRequest {
  rows: PlanRow[];
  workspace: string;
}

export interface AcceptPlanResponse {
  spawnedAgentIds: string[];
}

export interface OrchestratorApi {
  ping: () => Promise<AppPingResponse>;
  getSettings: () => Promise<Settings>;
  setSettings: (next: Partial<Settings>) => Promise<Settings>;
  listAgents: () => Promise<Agent[]>;
  spawnAgent: (req: SpawnAgentRequest) => Promise<SpawnAgentResponse>;
  abortAgent: (id: string) => Promise<{ ok: boolean }>;
  pickWorkspace: () => Promise<PickWorkspaceResponse>;
  listDirectorMessages: () => Promise<DirectorMessage[]>;
  sendToDirector: (body: string) => Promise<{ ok: true }>;
  acceptPlan: (req: AcceptPlanRequest) => Promise<AcceptPlanResponse>;
  abortDirector: () => Promise<{ ok: true }>;
  onAgent: (cb: (p: AgentEventAgentPayload) => void) => () => void;
  onLog: (cb: (p: AgentEventLogPayload) => void) => () => void;
  onPatch: (cb: (p: AgentEventPatchPayload) => void) => () => void;
  onDirectorMessage: (cb: (p: DirectorEventMessagePayload) => void) => () => void;
  onDirectorPatch: (cb: (p: DirectorEventPatchPayload) => void) => () => void;
}

declare global {
  interface Window {
    api: OrchestratorApi;
  }
}
