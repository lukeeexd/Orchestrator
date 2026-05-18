import type {
  Agent,
  DirectorMessage,
  DirectorMode,
  LogLine,
  PlanRow,
  Project,
  ForkAgentRequest,
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
  AgentFork: 'agent:fork',
  AgentSetModel: 'agent:setModel',
  AgentSetEffort: 'agent:setEffort',
  AgentPickWorkspace: 'agent:pickWorkspace',
  AttachmentPick: 'attachment:pick',
  AttachmentSavePaste: 'attachment:savePaste',
  AttachmentDispose: 'attachment:dispose',
  AttachmentDescribePaths: 'attachment:describePaths',
  DirectorList: 'director:list',
  DirectorSend: 'director:send',
  DirectorAcceptPlan: 'director:acceptPlan',
  DirectorAckRedirect: 'director:ackRedirect',
  DirectorAbort: 'director:abort',
  DirectorWipe: 'director:wipe',
  ProjectList: 'project:list',
  ProjectCreate: 'project:create',
  ProjectSetActive: 'project:setActive',
  ProjectRename: 'project:rename',
  ProjectSetWorkspace: 'project:setWorkspace',
  ProjectSetDirectorModel: 'project:setDirectorModel',
  ProjectSetDirectorEffort: 'project:setDirectorEffort',
  ProjectSetRoleTools: 'project:setRoleTools',
  ProjectDelete: 'project:delete',
  ProjectGetActive: 'project:getActive',
  AppShowSettingsFile: 'app:showSettingsFile',
  AppCliStatus: 'app:cliStatus',
  AppCliStatusByProvider: 'app:cliStatusByProvider',
  AppOpenUsage: 'app:openUsage',
  SpendGet: 'spend:get',
  HistoryList: 'history:list',
  CommandsList: 'commands:list',
  SkillsList: 'skills:list',
  SkillsSet: 'skills:set',
  UpdaterRestart: 'updater:restart',
  UpdaterEventDownloaded: 'updater:event:update-downloaded',
  // Renderer-bound streaming events:
  AgentEventAgent: 'agent:event:agent',
  AgentEventLog: 'agent:event:log',
  AgentEventPatch: 'agent:event:patch',
  AgentEventRemove: 'agent:event:remove',
  DirectorEventMessage: 'director:event:message',
  DirectorEventPatch: 'director:event:patch',
  DirectorEventCleared: 'director:event:cleared',
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
  /** Model used by spawned agents unless the spawn overrides it. */
  defaultModel: string;
  /** Reasoning effort applied to spawned agents unless overridden. Defaults to 'high'. */
  defaultEffort: import('./types').EffortLevel;
  /** Model used by the Director when the project hasn't picked one. */
  defaultDirectorModel: string;
  /** Effort used by the Director when the project hasn't picked one. */
  defaultDirectorEffort: import('./types').EffortLevel;
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

/** Single attachment info, mirroring main/attachments.ts AttachmentInfo. Used by savePastedImage. */
export interface PastedImageInfo {
  path: string;
  name: string;
  ok: boolean;
  reason?: string;
  kind?: 'text' | 'image' | 'unsupported';
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

export interface SkillEntry {
  key: import('./types').SkillKey;
  content: string;
  hasFile: boolean;
  path: string | null;
}

export interface AcceptPlanRequest {
  projectId: string;
  rows: PlanRow[];
  workspace: string;
  /**
   * Attachment paths from the user message that prompted this plan.
   * Forwarded to every agent the plan auto-spawns so they see the same
   * images/text the Director did. Without this, the Director can
   * describe a screenshot in its plan, but the coder/qa/etc agents
   * receive only the plan's task text and never the image itself.
   */
  attachments?: string[];
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
  forkAgent: (
    req: ForkAgentRequest,
  ) => Promise<{ ok: boolean; agentId?: string; error?: string }>;
  setAgentModel: (id: string, model: string) => Promise<{ ok: boolean }>;
  setAgentEffort: (
    id: string,
    effort: import('./types').EffortLevel,
  ) => Promise<{ ok: boolean }>;
  pickWorkspace: () => Promise<PickWorkspaceResponse>;
  pickAttachments: () => Promise<PickAttachmentsResponse>;
  /**
   * Save a base64-encoded image (typically from a clipboard paste) to a
   * temp file and return an AttachmentInfo the UI can treat as if the
   * user had picked it via the file dialog. The downstream runner reads
   * the temp file and base64-encodes it again for the vision content
   * block; round-trip is acceptable in exchange for a uniform pipeline.
   */
  savePastedImage: (
    base64: string,
    mediaType: string,
  ) => Promise<PastedImageInfo>;
  /**
   * Best-effort cleanup of an ephemeral attachment file (a path the user
   * just removed from a chip list). The main side validates that the path
   * is inside our managed temp subdir before deleting — picked attachments
   * (the user's own files outside that subdir) are silently ignored, so
   * the renderer can call this for every chip removal without tracking
   * which ones we own.
   */
  disposeAttachment: (path: string) => Promise<{ ok: boolean }>;
  /**
   * Run describeAttachments on a list of paths and return the chip-shaped
   * results. Used by the drag-drop handler for non-image files — the
   * renderer resolves dropped File objects to disk paths via
   * `getDroppedFilePath` and then validates them through this channel.
   */
  describeAttachmentPaths: (paths: string[]) => Promise<PastedImageInfo[]>;
  /**
   * Resolve a File object (typically from a drag-drop or file input) to
   * its absolute disk path. Runs in the preload context via Electron's
   * webUtils.getPathForFile — the only way to get the path with
   * contextIsolation on, since File.path was removed for security.
   * Returns an empty string if the File doesn't correspond to a real
   * on-disk file (e.g. an in-memory blob).
   */
  getDroppedFilePath: (file: File) => string;
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
  wipeDirector: (projectId: string) => Promise<{ ok: true }>;
  // Projects
  listProjects: () => Promise<Project[]>;
  createProject: (
    name: string,
    workspace: string,
    provider?: import('./types').Provider,
  ) => Promise<Project>;
  setActiveProject: (id: string) => Promise<{ ok: true }>;
  renameProject: (id: string, name: string) => Promise<{ ok: true }>;
  setProjectDirectorModel: (id: string, model: string) => Promise<{ ok: true }>;
  setProjectDirectorEffort: (
    id: string,
    effort: import('./types').EffortLevel,
  ) => Promise<{ ok: true }>;
  setProjectRoleTools: (
    id: string,
    roleTools: Partial<Record<import('./types').AgentRole, string[]>> | null,
  ) => Promise<{ ok: true }>;
  setProjectWorkspace: (id: string, workspace: string) => Promise<{ ok: true }>;
  deleteProject: (id: string) => Promise<{ ok: true }>;
  getActiveProjectId: () => Promise<string | null>;
  showSettingsFile: () => Promise<{ ok: boolean }>;
  getClaudeCliStatus: () => Promise<{
    available: boolean;
    version: string | null;
  }>;
  /** Status for a specific provider's CLI (claude / codex). */
  getCliStatus: (
    provider: import('./types').Provider,
  ) => Promise<{ available: boolean; version: string | null }>;
  openClaudeUsage: () => Promise<{ ok: boolean }>;
  getSpendSummary: () => Promise<import('./types').SpendSummary>;
  listHistory: () => Promise<import('./types').HistoryRow[]>;
  listSlashCommands: (
    projectId: string | null,
  ) => Promise<import('./commands').SlashCommand[]>;
  listSkills: (projectId: string) => Promise<SkillEntry[]>;
  setSkill: (
    projectId: string,
    key: import('./types').SkillKey,
    content: string,
  ) => Promise<{ ok: boolean; entry?: SkillEntry; error?: string }>;
  restartToUpdate: () => Promise<void>;
  onUpdateDownloaded: (
    cb: (p: { version: string; notes: string }) => void,
  ) => () => void;
  // Streams
  onAgent: (cb: (p: AgentEventAgentPayload) => void) => () => void;
  onLog: (cb: (p: AgentEventLogPayload) => void) => () => void;
  onPatch: (cb: (p: AgentEventPatchPayload) => void) => () => void;
  onAgentRemove: (cb: (p: AgentEventRemovePayload) => void) => () => void;
  onDirectorMessage: (cb: (p: DirectorEventMessagePayload) => void) => () => void;
  onDirectorPatch: (cb: (p: DirectorEventPatchPayload) => void) => () => void;
  onDirectorCleared: (
    cb: (p: { projectId: string }) => void,
  ) => () => void;
  onActiveProjectChanged: (cb: (p: ProjectActiveChangedPayload) => void) => () => void;
  onSettingsChanged: (cb: (p: Settings) => void) => () => void;
}

declare global {
  interface Window {
    api: OrchestratorApi;
  }
}
