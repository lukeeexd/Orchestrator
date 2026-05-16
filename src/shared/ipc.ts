import type {
  Agent,
  DirectorMessage,
  DirectorMode,
  LogLine,
  PlanRow,
  Project,
  RedirectAgentRequest,
  SpawnAgentRequest,
} from './types';

export const IpcChannels = {
  AppPing: 'app:ping',
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  AgentList: 'agent:list',
  AgentSpawn: 'agent:spawn',
  AgentAbort: 'agent:abort',
  AgentRemove: 'agent:remove',
  AgentRedirect: 'agent:redirect',
  AgentPickWorkspace: 'agent:pickWorkspace',
  AttachmentPick: 'attachment:pick',
  DirectorList: 'director:list',
  DirectorSend: 'director:send',
  DirectorAcceptPlan: 'director:acceptPlan',
  DirectorAckRedirect: 'director:ackRedirect',
  DirectorAbort: 'director:abort',
  ProjectList: 'project:list',
  ProjectCreate: 'project:create',
  ProjectSetActive: 'project:setActive',
  ProjectRename: 'project:rename',
  ProjectSetWorkspace: 'project:setWorkspace',
  ProjectSetDirectorModel: 'project:setDirectorModel',
  ProjectDelete: 'project:delete',
  ProjectGetActive: 'project:getActive',
  AppShowSettingsFile: 'app:showSettingsFile',
  // Renderer-bound streaming events:
  AgentEventAgent: 'agent:event:agent',
  AgentEventLog: 'agent:event:log',
  AgentEventPatch: 'agent:event:patch',
  AgentEventRemove: 'agent:event:remove',
  DirectorEventMessage: 'director:event:message',
  DirectorEventPatch: 'director:event:patch',
  ProjectEventActiveChanged: 'project:event:activeChanged',
  SettingsEventChanged: 'settings:event:changed',
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
  /** Per-agent dollar cap. 0 = unlimited. */
  defaultBudgetUsd: number;
  /** Per-agent token cap (input + output). 0 = unlimited. */
  defaultBudgetTokens: number;
  /** Per-agent wall-clock cap in seconds. 0 = unlimited. */
  defaultBudgetSeconds: number;
}

export interface SpawnAgentResponse {
  ok: true;
  agentId: string;
}

export interface PickWorkspaceResponse {
  path: string | null;
}

export interface PickAttachmentsResponse {
  attachments: { path: string; name: string; ok: boolean; reason?: string }[];
}

export interface AgentEventAgentPayload {
  projectId: string;
  agent: Agent;
}

export interface AgentEventLogPayload {
  projectId: string;
  agentId: string;
  line: LogLine;
}

export interface AgentEventPatchPayload {
  projectId: string;
  agentId: string;
  patch: Partial<Agent>;
}

export interface AgentEventRemovePayload {
  projectId: string;
  agentId: string;
}

export interface DirectorEventMessagePayload {
  projectId: string;
  message: DirectorMessage;
}

export interface DirectorEventPatchPayload {
  projectId: string;
  id: string;
  patch: Partial<DirectorMessage>;
}

export interface ProjectActiveChangedPayload {
  projectId: string;
}

export interface AcceptPlanRequest {
  projectId: string;
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
  listAgents: (projectId: string) => Promise<Agent[]>;
  spawnAgent: (req: SpawnAgentRequest) => Promise<SpawnAgentResponse>;
  abortAgent: (id: string) => Promise<{ ok: boolean }>;
  removeAgent: (id: string) => Promise<{ ok: boolean }>;
  redirectAgent: (req: RedirectAgentRequest) => Promise<{ ok: boolean; error?: string }>;
  pickWorkspace: () => Promise<PickWorkspaceResponse>;
  pickAttachments: () => Promise<PickAttachmentsResponse>;
  listDirectorMessages: (projectId: string) => Promise<DirectorMessage[]>;
  sendToDirector: (
    projectId: string,
    body: string,
    mode: DirectorMode,
    attachments?: string[],
  ) => Promise<{ ok: true }>;
  acceptPlan: (req: AcceptPlanRequest) => Promise<AcceptPlanResponse>;
  ackDirectorRedirect: (req: {
    projectId: string;
    messageId: string;
    agentName: string;
    ok: boolean;
    error?: string;
  }) => Promise<{ ok: true }>;
  abortDirector: (projectId: string) => Promise<{ ok: true }>;
  // Projects
  listProjects: () => Promise<Project[]>;
  createProject: (name: string, workspace: string) => Promise<Project>;
  setActiveProject: (id: string) => Promise<{ ok: true }>;
  renameProject: (id: string, name: string) => Promise<{ ok: true }>;
  setProjectDirectorModel: (id: string, model: string) => Promise<{ ok: true }>;
  setProjectWorkspace: (id: string, workspace: string) => Promise<{ ok: true }>;
  deleteProject: (id: string) => Promise<{ ok: true }>;
  getActiveProjectId: () => Promise<string | null>;
  showSettingsFile: () => Promise<{ ok: boolean }>;
  // Streams
  onAgent: (cb: (p: AgentEventAgentPayload) => void) => () => void;
  onLog: (cb: (p: AgentEventLogPayload) => void) => () => void;
  onPatch: (cb: (p: AgentEventPatchPayload) => void) => () => void;
  onAgentRemove: (cb: (p: AgentEventRemovePayload) => void) => () => void;
  onDirectorMessage: (cb: (p: DirectorEventMessagePayload) => void) => () => void;
  onDirectorPatch: (cb: (p: DirectorEventPatchPayload) => void) => () => void;
  onActiveProjectChanged: (cb: (p: ProjectActiveChangedPayload) => void) => () => void;
  onSettingsChanged: (cb: (p: Settings) => void) => () => void;
}

declare global {
  interface Window {
    api: OrchestratorApi;
  }
}
