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
  AttachmentReadThumb: 'attachment:readThumb',
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
  ProjectSetDirectorProvider: 'project:setDirectorProvider',
  ProjectSetMcpConfig: 'project:setMcpConfig',
  MarketplaceListSources: 'marketplace:listSources',
  MarketplaceListBundles: 'marketplace:listBundles',
  MarketplaceListSubscriptions: 'marketplace:listSubscriptions',
  MarketplaceSubscribe: 'marketplace:subscribe',
  MarketplaceUnsubscribe: 'marketplace:unsubscribe',
  MarketplaceRefresh: 'marketplace:refresh',
  MarketplaceAckUpdate: 'marketplace:ackUpdate',
  MarketplaceSetRoles: 'marketplace:setRoles',
  MarketplaceMoveScope: 'marketplace:moveScope',
  MarketplaceEventSourcePatch: 'marketplace:event:sourcePatch',
  MarketplaceEventSubscriptionsChanged: 'marketplace:event:subscriptionsChanged',
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

/**
 * Sentinel project id used to scope a subscription "globally" — i.e.
 * loaded into every project's claude spawns. Stored in project_id of
 * project_subscribed_bundles so we don't need a separate table.
 *
 * Real project ids are UUIDs, so this literal can't collide.
 */
export const MARKETPLACE_GLOBAL_SCOPE_ID = '__global__';

/** Renderer-shaped view of one skill_sources row. */
export interface MarketplaceSourceView {
  id: string;
  repo: string;
  defaultBranch: string;
  enabled: boolean;
  addedAt: number;
  lastSyncAt: number | null;
  lastSyncSha: string | null;
  /** Set when a sync is in flight (UI shows a spinner). */
  syncing?: boolean;
  /** Set when the last sync attempt failed. Cleared on the next success. */
  syncError?: string;
}

/** Renderer-shaped view of one marketplace.json bundle entry. */
export interface MarketplaceBundleView {
  id: string;
  /** Relative path from the repo root, mirrors marketplace.json::plugins[].source. */
  source: string;
  description: string;
  version: string;
  category?: string;
  keywords?: string[];
}

/** Renderer-shaped view of a project's subscribed bundle. */
export interface MarketplaceSubscriptionView {
  /** Either a real project UUID or MARKETPLACE_GLOBAL_SCOPE_ID. */
  projectId: string;
  sourceId: string;
  bundleId: string;
  subscribedAt: number;
  /** Version the user last acknowledged. Compare to current bundle.version for "update available". */
  installedVersion: string | null;
  /**
   * Per-role enablement. `null` = all roles load the bundle (default
   * at install). Otherwise: only the listed AgentRole keys plus
   * 'director' (if present). An empty array subscribes the bundle
   * without making it available to any role — the UI surfaces that
   * as a "no agents" hint.
   */
  roles: string[] | null;
  /** Derived from projectId — 'global' for the sentinel, 'project' otherwise. */
  scope: 'global' | 'project';
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
  /**
   * Read an image attachment off disk and return it as a `data:` URL the
   * renderer can use directly as `<img src>`. Returns an empty string for
   * non-image extensions, missing files, oversized files, or read
   * errors — the caller falls back to the generic attach icon.
   */
  readAttachmentThumb: (path: string) => Promise<string>;
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
  /**
   * Set the Director's provider override for a project, or clear it
   * by passing null. The main side also resets the Director's stored
   * session id — the new CLI can't resume a session created by the
   * old one, so the next turn starts fresh. Chat history stays put.
   */
  setProjectDirectorProvider: (
    id: string,
    provider: import('./types').Provider | null,
  ) => Promise<{ ok: true }>;
  /**
   * Save a project's MCP server config — JSON string in the
   * `claude --mcp-config` shape (typically `{"mcpServers": {...}}`).
   * Pass null or empty to clear. The main side validates that the
   * payload parses as JSON; an invalid string returns
   * `{ ok: false, error }` instead of corrupting the project record.
   * Claude spawns pick up the new config on their next run; codex
   * spawns ignore MCP entirely (codex exec has no equivalent flag).
   */
  setProjectMcpConfig: (
    id: string,
    config: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
  // ───────────────────────── Skill marketplace ─────────────────────────
  /** Configured marketplace sources (the alirezarezvani repo etc.). */
  listMarketplaceSources: () => Promise<MarketplaceSourceView[]>;
  /** Bundles available from a synced source. Empty until the source has been synced at least once. */
  listMarketplaceBundles: (
    sourceId: string,
  ) => Promise<MarketplaceBundleView[]>;
  /** A project's installed-bundle subscriptions (which (source, bundle) pairs to load on spawn). */
  listMarketplaceSubscriptions: (
    projectId: string,
  ) => Promise<MarketplaceSubscriptionView[]>;
  /**
   * Install a bundle. `projectId` is either the active project id (for
   * a project-scoped subscription) or MARKETPLACE_GLOBAL_SCOPE_ID for
   * a global one. Sets installed_version to the current marketplace
   * version. The renderer's default install path uses the global
   * scope — most bundles are useful project-agnostically.
   */
  subscribeMarketplaceBundle: (
    projectId: string,
    sourceId: string,
    bundleId: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Move an existing subscription between global and a specific
   * project (or vice versa). Preserves installed_version + roles, so
   * the user doesn't have to re-pick the per-role chip config after a
   * move. Returns `{ ok: false }` if no subscription is at `from`.
   */
  moveMarketplaceSubscription: (
    sourceId: string,
    bundleId: string,
    fromProjectId: string,
    toProjectId: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Uninstall. */
  unsubscribeMarketplaceBundle: (
    projectId: string,
    sourceId: string,
    bundleId: string,
  ) => Promise<{ ok: true }>;
  /** Force a sync now. Returns the new SHA + whether anything changed. */
  refreshMarketplaceSource: (
    sourceId: string,
  ) => Promise<{ ok: boolean; sha?: string; changed?: boolean; error?: string }>;
  /** Acknowledge a bundle update, snapping installed_version forward to current. Clears the update badge for that subscription. */
  acknowledgeMarketplaceUpdate: (
    projectId: string,
    sourceId: string,
    bundleId: string,
  ) => Promise<{ ok: true }>;
  /**
   * Set per-role enablement for a subscribed bundle. Pass `null` for
   * "all roles" (default at install) or an array of role keys. Empty
   * array = subscribed but disabled for every role.
   */
  setMarketplaceBundleRoles: (
    projectId: string,
    sourceId: string,
    bundleId: string,
    roles: string[] | null,
  ) => Promise<{ ok: true }>;
  /** Subscribe to source-row patches (sync state, badges, error). */
  onMarketplaceSourcePatch: (
    cb: (p: { sourceId: string; patch: Partial<MarketplaceSourceView> }) => void,
  ) => () => void;
  /** Fires when subscribe / unsubscribe / ackUpdate touches a project's subscription list, so any open hooks for that project can re-fetch. */
  onMarketplaceSubscriptionsChanged: (
    cb: (p: { projectId: string }) => void,
  ) => () => void;
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
