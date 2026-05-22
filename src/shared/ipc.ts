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
  ProjectPreviewMcpConfigCommands: 'project:previewMcpConfigCommands',
  MarketplaceListSources: 'marketplace:listSources',
  MarketplaceListBundles: 'marketplace:listBundles',
  MarketplaceListSubscriptions: 'marketplace:listSubscriptions',
  MarketplaceSubscribe: 'marketplace:subscribe',
  MarketplaceUnsubscribe: 'marketplace:unsubscribe',
  MarketplaceRefresh: 'marketplace:refresh',
  MarketplaceAckUpdate: 'marketplace:ackUpdate',
  MarketplaceSetRoles: 'marketplace:setRoles',
  MarketplaceMoveScope: 'marketplace:moveScope',
  MarketplaceAddSource: 'marketplace:addSource',
  MarketplaceRemoveSource: 'marketplace:removeSource',
  MarketplaceSetSourceEnabled: 'marketplace:setSourceEnabled',
  MarketplaceListBundleSkills: 'marketplace:listBundleSkills',
  MarketplaceReadSkill: 'marketplace:readSkill',
  MarketplaceResolveLoadout: 'marketplace:resolveLoadout',
  MarketplaceListFireCounts: 'marketplace:listFireCounts',
  MarketplaceGetLoadoutInsights: 'marketplace:getLoadoutInsights',
  MarketplaceAuditSource: 'marketplace:auditSource',
  MarketplaceSetSkills: 'marketplace:setSkills',
  MarketplaceGetChangelog: 'marketplace:getChangelog',
  MarketplaceEventSourcesChanged: 'marketplace:event:sourcesChanged',
  MarketplaceEventSourcePatch: 'marketplace:event:sourcePatch',
  MarketplaceEventSubscriptionsChanged: 'marketplace:event:subscriptionsChanged',
  ProjectSetRoleTools: 'project:setRoleTools',
  ProjectDelete: 'project:delete',
  ProjectGetActive: 'project:getActive',
  AppShowSettingsFile: 'app:showSettingsFile',
  AppCliStatusByProvider: 'app:cliStatusByProvider',
  AppOpenUsage: 'app:openUsage',
  AppHasWorkspaceMd: 'app:hasWorkspaceMd',
  ProjectScaffoldMcpServer: 'project:scaffoldMcpServer',
  CrashesList: 'crashes:list',
  CrashesClear: 'crashes:clear',
  CrashesOpenFolder: 'crashes:openFolder',
  CrashesRecordRenderer: 'crashes:recordRenderer',
  /** F9: bundle a crash + recent forensics into a shareable .zip. */
  CrashesExportBundle: 'crashes:exportBundle',
  /** List memory proposals filterable by project + role + status. */
  MemoryListProposals: 'memory:listProposals',
  /** Approve a proposal — appends body to the per-role skill file, marks approved. */
  MemoryApproveProposal: 'memory:approveProposal',
  /** Reject a proposal — marks rejected, doesn't touch the per-role skill. */
  MemoryRejectProposal: 'memory:rejectProposal',
  /** Renderer-bound: fired when an agent emits a new orchestrator-memory block. */
  MemoryEventProposal: 'memory:event:proposal',
  /** List a directory for the Docs rail screen — directories + .md files only. */
  DocsListDirectory: 'docs:listDirectory',
  /** Read a single .md file for the Docs rail screen viewer. */
  DocsReadFile: 'docs:readFile',
  /** Open a folder picker to choose the Docs rail screen's root. */
  DocsPickFolder: 'docs:pickFolder',
  SpendGet: 'spend:get',
  SpendRecommendations: 'spend:recommendations',
  /** F7: pre-spawn cost forecast for a plan. Returns ±50% band over per-role medians. */
  SpendForecastPlan: 'spend:forecastPlan',
  HistoryList: 'history:list',
  CommandsList: 'commands:list',
  SkillsList: 'skills:list',
  SkillsSet: 'skills:set',
  TemplatesList: 'templates:list',
  TemplatesCreate: 'templates:create',
  TemplatesUpdate: 'templates:update',
  TemplatesDelete: 'templates:delete',
  TemplatesUse: 'templates:use',
  UpdaterRestart: 'updater:restart',
  UpdaterEventDownloaded: 'updater:event:update-downloaded',
  /**
   * S6: secondary update channel reports a newer version than the
   * running app. Payload includes a public downloadUrl the renderer
   * can open via shell.openExternal — manual install, not in-app
   * auto-update.
   */
  UpdaterEventSecondaryAvailable: 'updater:event:secondary-available',
  /** S6: opens the secondary channel's public download URL in the user's browser. */
  UpdaterOpenSecondaryDownload: 'updater:openSecondaryDownload',
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
  /**
   * When true, creating a new project copies every current
   * marketplace global-scope subscription into the new project as a
   * project-scoped sub. Useful when you want each project to start
   * with the global baseline AND be able to customize roles / skills
   * per project without dragging the rest of the projects along.
   * Defaults to false — preserves the simple "global = applies
   * everywhere" model for users who don't want the duplication.
   */
  copyGlobalSubsToNewProjects: boolean;
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

/**
 * The pre-seeded default marketplace source. Treated specially in the
 * UI — can't be removed via the Remove button (removing it would just
 * cause the next launch's seed to re-add it; cleaner to just disable
 * it if a user really doesn't want it).
 */
export const MARKETPLACE_DEFAULT_SOURCE_ID = 'alirezarezvani/claude-skills';

/**
 * Curated "Recommended setup" — what the Marketplace screen's one-click
 * Apply button installs. Subscribes the default source's
 * `engineering-team` bundle globally with a per-role skill map: each
 * agent role gets a tight, role-specific skill list. Claude's
 * description-matching auto-loader handles per-task routing within the
 * narrowed set.
 *
 * The skill list is deliberately tight, not exhaustive. Loading every
 * skill in the bundle bloats every spawn's available-skill list and
 * confuses the auto-loader. Tune via the Agent skills view if you
 * want a different mix.
 */
export interface MarketplaceRecommendedBundle {
  bundleId: string;
  /**
   * Roles to bind the bundle to. `null` = every agent role can load
   * skills from this bundle (assuming they appear in `skillsByRole`).
   * Roles missing from `skillsByRole` get no skills from this bundle
   * even if they're allowed via `roles`.
   */
  roles: string[] | null;
  /**
   * Per-role skill map. Keys are agent role ids (pm, researcher,
   * coder, qa, devops, security, director); values are the skill ids
   * to load for that role. Missing keys = no skills from this bundle
   * for that role.
   */
  skillsByRole: Record<string, string[]>;
}

export const MARKETPLACE_RECOMMENDED_DEFAULTS: {
  sourceId: string;
  bundles: MarketplaceRecommendedBundle[];
} = {
  sourceId: MARKETPLACE_DEFAULT_SOURCE_ID,
  bundles: [
    {
      bundleId: 'engineering-team',
      roles: null,
      skillsByRole: {
        pm: ['senior-architect', 'epic-design'],
        researcher: ['tech-stack-evaluator'],
        coder: [
          'code-reviewer',
          'tdd-guide',
          'senior-architect',
          'senior-prompt-engineer',
        ],
        qa: ['adversarial-reviewer', 'senior-qa', 'tdd-guide'],
        devops: ['senior-devops', 'incident-response'],
        security: [
          'senior-security',
          'senior-secops',
          'adversarial-reviewer',
          'cloud-security',
          'threat-detection',
        ],
        director: ['senior-architect', 'epic-design'],
      },
    },
  ],
};

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

/**
 * Per-skill enablement on a subscription. Three shapes:
 *
 * - `null` — load every skill in the bundle for every enabled role
 *   (default at install).
 * - `string[]` (flat / legacy) — load these skills for every enabled
 *   role. Preserves the pre-v19 "Pick" flow and any older rows.
 * - `Record<role, string[]>` (per-role) — coder, qa, director, etc.
 *   each get their own skill list. Roles missing from the map
 *   contribute no skills from this bundle. The runner materializes a
 *   per-role synthetic plugin dir on spawn so different roles see
 *   different SKILL.md files even when the source bundle is shared.
 */
export type MarketplaceSelectedSkills =
  | null
  | string[]
  | Record<string, string[]>;

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
   *
   * L4: narrowed from `string[] | null` to the actual union the
   * runtime enforces. Anything else round-trips a no-op.
   */
  roles: Array<import('./types').AgentRole | 'director'> | null;
  selectedSkills: MarketplaceSelectedSkills;
  /** Derived from projectId — 'global' for the sentinel, 'project' otherwise. */
  scope: 'global' | 'project';
}

/** One skill within a bundle, surfaced for the skill-picker UI. */
export interface MarketplaceBundleSkillView {
  /** Subdir name inside the bundle. */
  id: string;
  /** Human label from SKILL.md frontmatter `name:`. */
  name?: string;
  /** One-liner from SKILL.md frontmatter `description:`. */
  description?: string;
}

/** One version section parsed from a source's CHANGELOG.md. */
export interface MarketplaceChangelogEntry {
  version: string;
  date?: string;
  body: string;
}

/**
 * One bundle's contribution to a role's resolved spawn-time loadout.
 * Mirrors marketplace.LoadoutEntry; lives here so the renderer types
 * don't cross into main.
 */
export interface MarketplaceLoadoutEntry {
  sourceId: string;
  bundleId: string;
  scope: 'global' | 'project';
  pluginDir: string | null;
  skills: MarketplaceBundleSkillView[];
  warning?: string;
}

export interface MarketplaceLoadoutReport {
  role: string;
  entries: MarketplaceLoadoutEntry[];
  totalSkills: number;
  approxFrontmatterChars: number;
}

/**
 * Telemetry row for a single skill in a project — how many times the
 * runner attributed a tool_use to it. Surfaced in Agent skills as
 * "fired Nx" chips so the user can spot dead skills.
 */
export interface MarketplaceSkillFireCount {
  projectId: string;
  role: string;
  sourceId: string;
  bundleId: string;
  skillId: string;
  count: number;
  lastFiredAt: number;
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

export interface McpScaffoldRequest {
  projectId: string;
  language: 'typescript' | 'python';
  /** Server id used in mcpConfig and as the directory name. */
  name: string;
  description: string;
  capabilities: {
    tools: boolean;
    resources: boolean;
    prompts: boolean;
  };
}

export interface McpScaffoldResult {
  ok: boolean;
  /** Absolute path of the destination directory on success. */
  destination?: string;
  /** Workspace-relative paths of the files written. */
  filesWritten?: string[];
  error?: string;
}

export interface TemplateCreateRequest {
  name: string;
  description?: string;
  mode?: import('./types').DirectorMode;
  tags?: string[];
  rows: PlanRow[];
}

export interface TemplateUpdateRequest {
  name?: string;
  description?: string;
  mode?: import('./types').DirectorMode;
  tags?: string[];
  rows?: PlanRow[];
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

/**
 * Returned by `acceptPlan`. Plans are spawned sequentially — rows
 * 2..N kick off in a detached loop that fires the next spawn only
 * after the previous one reaches a terminal status. So this is the
 * set of agent IDs that exist *at the time the IPC call resolves*,
 * not the full plan's worth.
 *
 * In practice that's always row 1 (the only spawn that happens
 * synchronously in acceptPlan). Subsequent rows surface to the
 * renderer via the `onAgent` event stream as they spawn. H10: the
 * old "array of all spawned IDs" contract was misleading — the
 * array always had exactly one (or zero) elements.
 */
export interface AcceptPlanResponse {
  /** Agent ID of the first row, if any. Empty for a zero-row plan. */
  firstSpawnedAgentId: string | null;
}

/**
 * Payload for the `ackDirectorRedirect` IPC. Promoted from three
 * inline copies (preload signature, main handler signature, renderer
 * call site) to a single named interface so a future field change
 * lands in one place. M13.
 */
export interface DirectorAckRedirectRequest {
  projectId: string;
  messageId: string;
  agentName: string;
  ok: boolean;
  error?: string;
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
  ackDirectorRedirect: (req: DirectorAckRedirectRequest) => Promise<{ ok: true }>;
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
  /**
   * Set the Director's per-project model override, or clear it by
   * passing `''` (empty string). The main side normalises empty to
   * NULL on the row, returning the project to the cascade default.
   */
  setProjectDirectorModel: (
    id: string,
    model: string,
  ) => Promise<{ ok: true }>;
  /**
   * Set the Director's per-project effort override, or clear it by
   * passing `null`. H10: the param was previously typed `EffortLevel`
   * only, so renderers had to bypass types to clear the override —
   * even though the main handler accepted null all along.
   */
  setProjectDirectorEffort: (
    id: string,
    effort: import('./types').EffortLevel | null,
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
  /**
   * Returns the list of commands the MCP config would spawn on each
   * agent run, parsed from `mcpServers[*].command`. Used by the
   * renderer to show a "this will execute X on every spawn"
   * confirmation step before commit. Empty config / invalid JSON
   * returns an empty commands array — the actual commit call
   * returns the parse error.
   */
  previewMcpConfigCommands: (
    config: string | null,
  ) => Promise<{ commands: string[] }>;
  /**
   * Returns the commands as part of the response so the renderer can
   * show a "saved — these commands will run on each spawn" confirm
   * message. Also pushed as a Director system message for an audit
   * trail the user can see later.
   */
  setProjectMcpConfig: (
    id: string,
    config: string | null,
  ) => Promise<{ ok: boolean; error?: string; commands?: string[] }>;
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
  /**
   * Add a new marketplace source by GitHub repo. `repo` is "owner/repo"
   * (https://github.com/ prefix stripped on the main side). Runs the
   * first sync inline so a bad repo errors immediately rather than
   * leaving a half-baked source row — the handler rolls back the row
   * on sync failure.
   */
  addMarketplaceSource: (
    repo: string,
    branch?: string,
  ) => Promise<{ ok: boolean; sourceId?: string; error?: string }>;
  /**
   * Remove a marketplace source. Cascades: every project's subscription
   * to bundles in that source is uninstalled, the on-disk cache dir is
   * removed, the source row deleted. Refuses to remove the default
   * source — disable it instead if you don't want it.
   */
  removeMarketplaceSource: (
    sourceId: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Toggle a source's enabled flag. Disabled sources keep their
   * subscriptions and cache on disk but stop contributing
   * `--plugin-dir` args to any claude spawn until re-enabled.
   * Cheaper than remove + re-add when you just want to temporarily
   * silence a source.
   */
  setMarketplaceSourceEnabled: (
    sourceId: string,
    enabled: boolean,
  ) => Promise<{ ok: true }>;
  /**
   * Enumerate the skills inside a bundle — walks the bundle dir on
   * disk and finds every subdirectory with a SKILL.md, parsing the
   * frontmatter's name + description for the picker UI.
   */
  listMarketplaceBundleSkills: (
    sourceId: string,
    bundleId: string,
  ) => Promise<MarketplaceBundleSkillView[]>;
  /**
   * Read the full SKILL.md text for a specific skill inside a bundle.
   * Returns `null` if the bundle's source hasn't been synced, the
   * skill subdir is missing, or the SKILL.md file isn't there.
   */
  readMarketplaceSkill: (
    sourceId: string,
    bundleId: string,
    skillId: string,
  ) => Promise<string | null>;
  /**
   * Resolve the dry-run loadout for a role in a project — what
   * --plugin-dir paths + skills a fresh spawn would receive, without
   * actually spawning.
   */
  resolveMarketplaceLoadout: (
    projectId: string,
    role: string,
  ) => Promise<MarketplaceLoadoutReport>;
  /**
   * Fetch every fire-count row for a project (across all roles).
   * Renderer groups them client-side to decorate Agent skills chips.
   */
  listMarketplaceFireCounts: (
    projectId: string,
  ) => Promise<MarketplaceSkillFireCount[]>;
  /**
   * Self-improving-loadout nudges over the active project's
   * subscriptions + cross-project fire data. Recomputed on every call;
   * cheap (a handful of DB reads + an in-memory join).
   */
  getMarketplaceLoadoutInsights: (
    projectId: string,
  ) => Promise<import('./types').LoadoutInsight[]>;
  /**
   * P7 — static heuristic audit of every SKILL.md in a freshly-synced
   * marketplace source. Returns one report per skill that triggered
   * at least one pattern match; clean skills are omitted. Default
   * source returns an empty array (the seed is vetted).
   */
  auditMarketplaceSource: (
    sourceId: string,
  ) => Promise<import('./types').SkillAuditReport[]>;
  /**
   * Set the per-skill subset for a subscription. Three forms:
   *   - `null` — all skills load for every enabled role (default).
   *   - `string[]` — these skills load for every enabled role (legacy
   *     flat form; still used by the Pick modal).
   *   - `Record<role, string[]>` — per-role skill picks. Each agent
   *     role gets its own list.
   * An empty array (or empty values inside the map) makes that role's
   * contribution from this subscription a no-op until reset.
   */
  setMarketplaceBundleSkills: (
    projectId: string,
    sourceId: string,
    bundleId: string,
    skills: MarketplaceSelectedSkills,
  ) => Promise<{ ok: true }>;
  /**
   * Return CHANGELOG.md entries from a source between two versions.
   * Used by the "What's new" link on a bundle card with a pending
   * update. Empty array when the source has no CHANGELOG, the
   * versions don't appear, or no entries fall in range.
   */
  getMarketplaceChangelog: (
    sourceId: string,
    fromVersion: string | null,
    toVersion: string,
  ) => Promise<MarketplaceChangelogEntry[]>;
  /** Subscribe to source-row patches (sync state, badges, error). */
  onMarketplaceSourcePatch: (
    cb: (p: { sourceId: string; patch: Partial<MarketplaceSourceView> }) => void,
  ) => () => void;
  /** Fires when a source is added or removed — broader-grained event than the per-row patch. */
  onMarketplaceSourcesChanged: (cb: () => void) => () => void;
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
  /** Status for a specific provider's CLI (claude / codex). */
  getCliStatus: (
    provider: import('./types').Provider,
  ) => Promise<{ available: boolean; version: string | null }>;
  openClaudeUsage: () => Promise<{ ok: boolean }>;
  /**
   * True when a `WORKSPACE.md` exists at the workspace root. Used by
   * the renderer's onboarding banner to decide whether the
   * codebase-onboarding nudge should appear for this project.
   */
  hasWorkspaceMd: (workspace: string) => Promise<boolean>;
  /**
   * P9 — scaffold a new MCP server in the project's workspace + auto-
   * register it in the project's mcpConfig. Returns the destination
   * path on success or a descriptive error.
   */
  scaffoldMcpServer: (input: McpScaffoldRequest) => Promise<McpScaffoldResult>;
  /**
   * S5: list the most recent crashes captured to userData/crashes/.
   * Local-only — there is no network upload. The Settings UI uses
   * this to render the Crashes section's count + last-crash preview.
   */
  listCrashes: () => Promise<import('./types').CrashEntry[]>;
  /** Delete every crash JSON in `userData/crashes/`. Returns the count removed. */
  clearCrashes: () => Promise<{ removed: number }>;
  /** Reveal `userData/crashes/` in the OS file explorer. */
  openCrashesFolder: () => Promise<{ ok: boolean }>;
  /**
   * F9: bundle a crash + recent Director messages + recent agents +
   * their log tails into a shareable .zip. The resulting file is
   * revealed in Explorer so the user can attach it in one click.
   */
  exportCrashBundle: (
    crashId: string,
    opts: { scrubSecrets: boolean },
  ) => Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  /**
   * Renderer-side React error boundary forwards captured errors
   * here. Main writes through the same pipeline as process-level
   * crashes.
   */
  recordRendererCrash: (payload: {
    name?: string;
    message?: string;
    stack?: string;
    componentStack?: string;
    url?: string;
  }) => Promise<{ ok: boolean }>;
  /**
   * List memory proposals for a project. Optionally filter by role
   * (the Memory tab uses the agent's role) and status (the queue
   * shows pending; history can show approved/rejected).
   */
  listMemoryProposals: (
    projectId: string,
    role?: import('./types').AgentRole,
    status?: import('./types').MemoryProposalStatus,
  ) => Promise<import('./types').MemoryProposal[]>;
  /**
   * Approve a proposal — appends body to the per-role skill file
   * (existing P4 storage) and marks the proposal approved.
   */
  approveMemoryProposal: (
    id: string,
  ) => Promise<
    | { ok: true; proposal: import('./types').MemoryProposal }
    | { ok: false; error: string }
  >;
  /** Reject a proposal — marks it rejected, leaves the per-role skill untouched. */
  rejectMemoryProposal: (
    id: string,
  ) => Promise<
    | { ok: true; proposal: import('./types').MemoryProposal }
    | { ok: false; error: string }
  >;
  /** Subscribe to new memory proposals as they're emitted by agents. */
  onMemoryProposal: (
    cb: (p: import('./types').MemoryProposal) => void,
  ) => () => void;
  /**
   * List a directory's contents for the Docs rail screen. Returns
   * directories (sorted alpha, common build/VCS dirs filtered) and
   * `.md` / `.markdown` files (sorted alpha after dirs); non-markdown
   * files are filtered out. Throws on non-existent paths.
   */
  docsListDirectory: (
    absPath: string,
  ) => Promise<{
    ok: true;
    listing: import('./types').MarkdownListing;
  } | { ok: false; error: string }>;
  /** Read a single markdown file's content (5 MiB cap; larger files come back truncated). */
  docsReadFile: (
    absPath: string,
  ) => Promise<{
    ok: true;
    file: import('./types').MarkdownFileContent;
  } | { ok: false; error: string }>;
  /** Open a folder picker for the Docs rail screen's root. */
  docsPickFolder: () => Promise<{ path: string | null }>;
  getSpendSummary: () => Promise<import('./types').SpendSummary>;
  /** Rule-based cost / loadout recommendations recomputed each call. */
  getSpendRecommendations: () => Promise<
    import('./types').SpendRecommendation[]
  >;
  /** F7: forecast spawn cost from per-role medians for a given plan. */
  forecastPlanCost: (
    rows: import('./types').PlanRow[],
  ) => Promise<import('./types').PlanCostForecast>;
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
  // ───────────────────────── Workflow templates ─────────────────────────
  /** Every template (built-ins first, then user-authored alphabetically). */
  listTemplates: () => Promise<import('./types').Template[]>;
  /** Create a new user-authored template from the given rows. */
  createTemplate: (
    input: TemplateCreateRequest,
  ) => Promise<import('./types').Template>;
  /** Update a user-authored template. Built-ins are read-only; returns the unchanged row. */
  updateTemplate: (
    id: string,
    patch: TemplateUpdateRequest,
  ) => Promise<{ ok: boolean; template?: import('./types').Template }>;
  /** Delete a user-authored template. Built-ins are protected; returns ok: false. */
  deleteTemplate: (id: string) => Promise<{ ok: boolean }>;
  /**
   * Synthesise a Director chat message carrying the template's plan
   * rows. The renderer's existing PlanCard handler picks it up and the
   * user can edit / drop rows / accept just like any Director-emitted
   * plan. Returns the inserted message so the caller can scroll to it.
   */
  useTemplate: (
    projectId: string,
    templateId: string,
  ) => Promise<{ ok: boolean; message?: DirectorMessage; error?: string }>;
  restartToUpdate: () => Promise<void>;
  onUpdateDownloaded: (
    cb: (p: { version: string; notes: string }) => void,
  ) => () => void;
  /**
   * S6: subscribes to the secondary update channel. Payload arrives
   * whenever the hosted `latest.json` reports a newer version than
   * the running app. The renderer surfaces a banner with a button
   * that calls `openSecondaryDownload(downloadUrl)`.
   */
  onSecondaryUpdateAvailable: (
    cb: (p: {
      version: string;
      downloadUrl: string;
      releasedAt?: string;
    }) => void,
  ) => () => void;
  /** S6: opens the secondary channel's download URL via the OS's default browser. */
  openSecondaryDownload: (url: string) => Promise<{ ok: boolean }>;
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
