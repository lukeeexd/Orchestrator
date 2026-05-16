import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
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
  pickWorkspace: () =>
    ipcRenderer.invoke(IpcChannels.AgentPickWorkspace) as Promise<PickWorkspaceResponse>,
  pickAttachments: () =>
    ipcRenderer.invoke(IpcChannels.AttachmentPick) as Promise<
      import('../shared/ipc').PickAttachmentsResponse
    >,

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

  // Projects
  listProjects: () =>
    ipcRenderer.invoke(IpcChannels.ProjectList) as Promise<Project[]>,
  createProject: (name, workspace) =>
    ipcRenderer.invoke(
      IpcChannels.ProjectCreate,
      name,
      workspace,
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
  deleteProject: (id) =>
    ipcRenderer.invoke(IpcChannels.ProjectDelete, id) as Promise<{ ok: true }>,
  getActiveProjectId: () =>
    ipcRenderer.invoke(IpcChannels.ProjectGetActive) as Promise<string | null>,
  showSettingsFile: () =>
    ipcRenderer.invoke(IpcChannels.AppShowSettingsFile) as Promise<{
      ok: boolean;
    }>,

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
  onActiveProjectChanged: (cb) =>
    subscribe<ProjectActiveChangedPayload>(
      IpcChannels.ProjectEventActiveChanged,
      cb,
    ),
  onSettingsChanged: (cb) =>
    subscribe<Settings>(IpcChannels.SettingsEventChanged, cb),
};

contextBridge.exposeInMainWorld('api', api);
