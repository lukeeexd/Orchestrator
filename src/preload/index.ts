import {
  contextBridge,
  ipcRenderer,
  webUtils,
  type IpcRendererEvent,
} from 'electron';
import {
  IpcChannels,
  type AcceptPlanRequest,
  type AcceptPlanResponse,
  type AgentEventAgentPayload,
  type AgentEventLogPayload,
  type AgentEventPatchPayload,
  type AgentEventRemovePayload,
  type AppPingResponse,
  type DirectorEventMessagePayload,
  type DirectorEventPatchPayload,
  type OrchestratorApi,
  type PickWorkspaceResponse,
  type ProjectActiveChangedPayload,
  type Settings,
  type SpawnAgentResponse,
} from '../shared/ipc';
import type {
  Agent,
  DirectorMessage,
  Project,
  SpawnAgentRequest,
} from '../shared/types';

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const api: OrchestratorApi = {
  ping: () => ipcRenderer.invoke(IpcChannels.AppPing) as Promise<AppPingResponse>,
  getSettings: () =>
    ipcRenderer.invoke(IpcChannels.SettingsGet) as Promise<Settings>,
  setSettings: (next) =>
    ipcRenderer.invoke(IpcChannels.SettingsSet, next) as Promise<Settings>,

  listAgents: (projectId) =>
    ipcRenderer.invoke(IpcChannels.AgentList, projectId) as Promise<Agent[]>,
  spawnAgent: (req: SpawnAgentRequest) =>
    ipcRenderer.invoke(IpcChannels.AgentSpawn, req) as Promise<SpawnAgentResponse>,
  abortAgent: (id) =>
    ipcRenderer.invoke(IpcChannels.AgentAbort, id) as Promise<{ ok: boolean }>,
  removeAgent: (id) =>
    ipcRenderer.invoke(IpcChannels.AgentRemove, id) as Promise<{ ok: boolean }>,
  redirectAgent: (req) =>
    ipcRenderer.invoke(IpcChannels.AgentRedirect, req) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  forkAgent: (req) =>
    ipcRenderer.invoke(IpcChannels.AgentFork, req) as Promise<{
      ok: boolean;
      agentId?: string;
      error?: string;
    }>,
  setAgentModel: (id, model) =>
    ipcRenderer.invoke(IpcChannels.AgentSetModel, id, model) as Promise<{
      ok: boolean;
    }>,
  setAgentEffort: (id, effort) =>
    ipcRenderer.invoke(IpcChannels.AgentSetEffort, id, effort) as Promise<{
      ok: boolean;
    }>,
  pickWorkspace: () =>
    ipcRenderer.invoke(IpcChannels.AgentPickWorkspace) as Promise<PickWorkspaceResponse>,
  pickAttachments: () =>
    ipcRenderer.invoke(IpcChannels.AttachmentPick) as Promise<
      import('../shared/ipc').PickAttachmentsResponse
    >,
  savePastedImage: (base64, mediaType) =>
    ipcRenderer.invoke(
      IpcChannels.AttachmentSavePaste,
      base64,
      mediaType,
    ) as Promise<import('../shared/ipc').PastedImageInfo>,
  disposeAttachment: (path) =>
    ipcRenderer.invoke(IpcChannels.AttachmentDispose, path) as Promise<{
      ok: boolean;
    }>,
  describeAttachmentPaths: (paths) =>
    ipcRenderer.invoke(
      IpcChannels.AttachmentDescribePaths,
      paths,
    ) as Promise<import('../shared/ipc').PastedImageInfo[]>,
  // Runs synchronously in the preload context using Electron's webUtils.
  // Returning a string (not a Promise) makes the drop-handler glue much
  // tidier — no extra await before we even have the path.
  getDroppedFilePath: (file: File) => webUtils.getPathForFile(file),
  readAttachmentThumb: (path) =>
    ipcRenderer.invoke(IpcChannels.AttachmentReadThumb, path) as Promise<string>,

  listDirectorMessages: (projectId) =>
    ipcRenderer.invoke(
      IpcChannels.DirectorList,
      projectId,
    ) as Promise<DirectorMessage[]>,
  sendToDirector: (projectId, body, mode, attachments) =>
    ipcRenderer.invoke(
      IpcChannels.DirectorSend,
      projectId,
      body,
      mode,
      attachments,
    ) as Promise<{ ok: true }>,
  acceptPlan: (req: AcceptPlanRequest) =>
    ipcRenderer.invoke(
      IpcChannels.DirectorAcceptPlan,
      req,
    ) as Promise<AcceptPlanResponse>,
  ackDirectorRedirect: (req) =>
    ipcRenderer.invoke(
      IpcChannels.DirectorAckRedirect,
      req,
    ) as Promise<{ ok: true }>,
  abortDirector: (projectId) =>
    ipcRenderer.invoke(IpcChannels.DirectorAbort, projectId) as Promise<{
      ok: true;
    }>,
  wipeDirector: (projectId) =>
    ipcRenderer.invoke(IpcChannels.DirectorWipe, projectId) as Promise<{
      ok: true;
    }>,

  // Projects
  listProjects: () =>
    ipcRenderer.invoke(IpcChannels.ProjectList) as Promise<Project[]>,
  createProject: (name, workspace, provider) =>
    ipcRenderer.invoke(
      IpcChannels.ProjectCreate,
      name,
      workspace,
      provider,
    ) as Promise<Project>,
  setActiveProject: (id) =>
    ipcRenderer.invoke(IpcChannels.ProjectSetActive, id) as Promise<{
      ok: true;
    }>,
  renameProject: (id, name) =>
    ipcRenderer.invoke(IpcChannels.ProjectRename, id, name) as Promise<{
      ok: true;
    }>,
  setProjectWorkspace: (id, workspace) =>
    ipcRenderer.invoke(
      IpcChannels.ProjectSetWorkspace,
      id,
      workspace,
    ) as Promise<{ ok: true }>,
  setProjectDirectorModel: (id, model) =>
    ipcRenderer.invoke(
      IpcChannels.ProjectSetDirectorModel,
      id,
      model,
    ) as Promise<{ ok: true }>,
  setProjectDirectorEffort: (id, effort) =>
    ipcRenderer.invoke(
      IpcChannels.ProjectSetDirectorEffort,
      id,
      effort,
    ) as Promise<{ ok: true }>,
  setProjectDirectorProvider: (id, provider) =>
    ipcRenderer.invoke(
      IpcChannels.ProjectSetDirectorProvider,
      id,
      provider,
    ) as Promise<{ ok: true }>,
  setProjectMcpConfig: (id, config) =>
    ipcRenderer.invoke(
      IpcChannels.ProjectSetMcpConfig,
      id,
      config,
    ) as Promise<{ ok: boolean; error?: string; commands?: string[] }>,
  previewMcpConfigCommands: (config) =>
    ipcRenderer.invoke(
      IpcChannels.ProjectPreviewMcpConfigCommands,
      config,
    ) as Promise<{ commands: string[] }>,

  // ─────────────────────────── Marketplace ───────────────────────────
  listMarketplaceSources: () =>
    ipcRenderer.invoke(IpcChannels.MarketplaceListSources) as Promise<
      import('../shared/ipc').MarketplaceSourceView[]
    >,
  listMarketplaceBundles: (sourceId) =>
    ipcRenderer.invoke(
      IpcChannels.MarketplaceListBundles,
      sourceId,
    ) as Promise<import('../shared/ipc').MarketplaceBundleView[]>,
  listMarketplaceSubscriptions: (projectId) =>
    ipcRenderer.invoke(
      IpcChannels.MarketplaceListSubscriptions,
      projectId,
    ) as Promise<import('../shared/ipc').MarketplaceSubscriptionView[]>,
  subscribeMarketplaceBundle: (projectId, sourceId, bundleId) =>
    ipcRenderer.invoke(
      IpcChannels.MarketplaceSubscribe,
      projectId,
      sourceId,
      bundleId,
    ) as Promise<{ ok: boolean; error?: string }>,
  unsubscribeMarketplaceBundle: (projectId, sourceId, bundleId) =>
    ipcRenderer.invoke(
      IpcChannels.MarketplaceUnsubscribe,
      projectId,
      sourceId,
      bundleId,
    ) as Promise<{ ok: true }>,
  refreshMarketplaceSource: (sourceId) =>
    ipcRenderer.invoke(
      IpcChannels.MarketplaceRefresh,
      sourceId,
    ) as Promise<{ ok: boolean; sha?: string; changed?: boolean; error?: string }>,
  acknowledgeMarketplaceUpdate: (projectId, sourceId, bundleId) =>
    ipcRenderer.invoke(
      IpcChannels.MarketplaceAckUpdate,
      projectId,
      sourceId,
      bundleId,
    ) as Promise<{ ok: true }>,
  setMarketplaceBundleRoles: (projectId, sourceId, bundleId, roles) =>
    ipcRenderer.invoke(
      IpcChannels.MarketplaceSetRoles,
      projectId,
      sourceId,
      bundleId,
      roles,
    ) as Promise<{ ok: true }>,
  moveMarketplaceSubscription: (
    sourceId,
    bundleId,
    fromProjectId,
    toProjectId,
  ) =>
    ipcRenderer.invoke(
      IpcChannels.MarketplaceMoveScope,
      sourceId,
      bundleId,
      fromProjectId,
      toProjectId,
    ) as Promise<{ ok: boolean; error?: string }>,
  addMarketplaceSource: (repo, branch) =>
    ipcRenderer.invoke(
      IpcChannels.MarketplaceAddSource,
      repo,
      branch,
    ) as Promise<{ ok: boolean; sourceId?: string; error?: string }>,
  removeMarketplaceSource: (sourceId) =>
    ipcRenderer.invoke(
      IpcChannels.MarketplaceRemoveSource,
      sourceId,
    ) as Promise<{ ok: boolean; error?: string }>,
  setMarketplaceSourceEnabled: (sourceId, enabled) =>
    ipcRenderer.invoke(
      IpcChannels.MarketplaceSetSourceEnabled,
      sourceId,
      enabled,
    ) as Promise<{ ok: true }>,
  listMarketplaceBundleSkills: (sourceId, bundleId) =>
    ipcRenderer.invoke(
      IpcChannels.MarketplaceListBundleSkills,
      sourceId,
      bundleId,
    ) as Promise<import('../shared/ipc').MarketplaceBundleSkillView[]>,
  readMarketplaceSkill: (sourceId, bundleId, skillId) =>
    ipcRenderer.invoke(
      IpcChannels.MarketplaceReadSkill,
      sourceId,
      bundleId,
      skillId,
    ) as Promise<string | null>,
  resolveMarketplaceLoadout: (projectId, role) =>
    ipcRenderer.invoke(
      IpcChannels.MarketplaceResolveLoadout,
      projectId,
      role,
    ) as Promise<import('../shared/ipc').MarketplaceLoadoutReport>,
  listMarketplaceFireCounts: (projectId) =>
    ipcRenderer.invoke(
      IpcChannels.MarketplaceListFireCounts,
      projectId,
    ) as Promise<import('../shared/ipc').MarketplaceSkillFireCount[]>,
  getMarketplaceLoadoutInsights: (projectId) =>
    ipcRenderer.invoke(
      IpcChannels.MarketplaceGetLoadoutInsights,
      projectId,
    ) as Promise<import('../shared/types').LoadoutInsight[]>,
  auditMarketplaceSource: (sourceId) =>
    ipcRenderer.invoke(
      IpcChannels.MarketplaceAuditSource,
      sourceId,
    ) as Promise<import('../shared/types').SkillAuditReport[]>,
  setMarketplaceBundleSkills: (projectId, sourceId, bundleId, skills) =>
    ipcRenderer.invoke(
      IpcChannels.MarketplaceSetSkills,
      projectId,
      sourceId,
      bundleId,
      skills,
    ) as Promise<{ ok: true }>,
  getMarketplaceChangelog: (sourceId, fromVersion, toVersion) =>
    ipcRenderer.invoke(
      IpcChannels.MarketplaceGetChangelog,
      sourceId,
      fromVersion,
      toVersion,
    ) as Promise<import('../shared/ipc').MarketplaceChangelogEntry[]>,
  onMarketplaceSourcePatch: (cb) =>
    subscribe<{
      sourceId: string;
      patch: Partial<import('../shared/ipc').MarketplaceSourceView>;
    }>(IpcChannels.MarketplaceEventSourcePatch, cb),
  onMarketplaceSubscriptionsChanged: (cb) =>
    subscribe<{ projectId: string }>(
      IpcChannels.MarketplaceEventSubscriptionsChanged,
      cb,
    ),
  onMarketplaceSourcesChanged: (cb) =>
    subscribe<void>(IpcChannels.MarketplaceEventSourcesChanged, () => cb()),
  setProjectRoleTools: (id, roleTools) =>
    ipcRenderer.invoke(
      IpcChannels.ProjectSetRoleTools,
      id,
      roleTools,
    ) as Promise<{ ok: true }>,
  deleteProject: (id) =>
    ipcRenderer.invoke(IpcChannels.ProjectDelete, id) as Promise<{ ok: true }>,
  getActiveProjectId: () =>
    ipcRenderer.invoke(IpcChannels.ProjectGetActive) as Promise<string | null>,
  showSettingsFile: () =>
    ipcRenderer.invoke(IpcChannels.AppShowSettingsFile) as Promise<{
      ok: boolean;
    }>,
  getCliStatus: (provider) =>
    ipcRenderer.invoke(
      IpcChannels.AppCliStatusByProvider,
      provider,
    ) as Promise<{ available: boolean; version: string | null }>,
  openClaudeUsage: () =>
    ipcRenderer.invoke(IpcChannels.AppOpenUsage) as Promise<{ ok: boolean }>,
  hasWorkspaceMd: (workspace) =>
    ipcRenderer.invoke(
      IpcChannels.AppHasWorkspaceMd,
      workspace,
    ) as Promise<boolean>,
  scaffoldMcpServer: (input) =>
    ipcRenderer.invoke(
      IpcChannels.ProjectScaffoldMcpServer,
      input,
    ) as Promise<import('../shared/ipc').McpScaffoldResult>,
  getSpendSummary: () =>
    ipcRenderer.invoke(IpcChannels.SpendGet) as Promise<
      import('../shared/types').SpendSummary
    >,
  getSpendRecommendations: () =>
    ipcRenderer.invoke(IpcChannels.SpendRecommendations) as Promise<
      import('../shared/types').SpendRecommendation[]
    >,
  listHistory: () =>
    ipcRenderer.invoke(IpcChannels.HistoryList) as Promise<
      import('../shared/types').HistoryRow[]
    >,
  listSlashCommands: (projectId) =>
    ipcRenderer.invoke(IpcChannels.CommandsList, projectId) as Promise<
      import('../shared/commands').SlashCommand[]
    >,
  listSkills: (projectId) =>
    ipcRenderer.invoke(IpcChannels.SkillsList, projectId) as Promise<
      import('../shared/ipc').SkillEntry[]
    >,
  setSkill: (projectId, role, content) =>
    ipcRenderer.invoke(
      IpcChannels.SkillsSet,
      projectId,
      role,
      content,
    ) as Promise<{
      ok: boolean;
      entry?: import('../shared/ipc').SkillEntry;
      error?: string;
    }>,

  listTemplates: () =>
    ipcRenderer.invoke(IpcChannels.TemplatesList) as Promise<
      import('../shared/types').Template[]
    >,
  createTemplate: (input) =>
    ipcRenderer.invoke(IpcChannels.TemplatesCreate, input) as Promise<
      import('../shared/types').Template
    >,
  updateTemplate: (id, patch) =>
    ipcRenderer.invoke(IpcChannels.TemplatesUpdate, id, patch) as Promise<{
      ok: boolean;
      template?: import('../shared/types').Template;
    }>,
  deleteTemplate: (id) =>
    ipcRenderer.invoke(IpcChannels.TemplatesDelete, id) as Promise<{
      ok: boolean;
    }>,
  useTemplate: (projectId, templateId) =>
    ipcRenderer.invoke(IpcChannels.TemplatesUse, projectId, templateId) as Promise<{
      ok: boolean;
      message?: import('../shared/types').DirectorMessage;
      error?: string;
    }>,

  restartToUpdate: () =>
    ipcRenderer.invoke(IpcChannels.UpdaterRestart) as Promise<void>,
  onUpdateDownloaded: (cb) =>
    subscribe<{ version: string; notes: string }>(
      IpcChannels.UpdaterEventDownloaded,
      cb,
    ),

  onAgent: (cb) => subscribe<AgentEventAgentPayload>(IpcChannels.AgentEventAgent, cb),
  onLog: (cb) => subscribe<AgentEventLogPayload>(IpcChannels.AgentEventLog, cb),
  onPatch: (cb) =>
    subscribe<AgentEventPatchPayload>(IpcChannels.AgentEventPatch, cb),
  onAgentRemove: (cb) =>
    subscribe<AgentEventRemovePayload>(IpcChannels.AgentEventRemove, cb),
  onDirectorMessage: (cb) =>
    subscribe<DirectorEventMessagePayload>(
      IpcChannels.DirectorEventMessage,
      cb,
    ),
  onDirectorPatch: (cb) =>
    subscribe<DirectorEventPatchPayload>(IpcChannels.DirectorEventPatch, cb),
  onDirectorCleared: (cb) =>
    subscribe<{ projectId: string }>(IpcChannels.DirectorEventCleared, cb),
  onActiveProjectChanged: (cb) =>
    subscribe<ProjectActiveChangedPayload>(
      IpcChannels.ProjectEventActiveChanged,
      cb,
    ),
  onSettingsChanged: (cb) =>
    subscribe<Settings>(IpcChannels.SettingsEventChanged, cb),
};

contextBridge.exposeInMainWorld('api', api);
