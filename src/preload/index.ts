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
  type Settings,
  type SpawnAgentResponse,
} from '../shared/ipc';
import type {
  Agent,
  DirectorMessage,
  SpawnAgentRequest,
} from '../shared/types';

function subscribe<T>(
  channel: string,
  cb: (payload: T) => void,
): () => void {
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

  listAgents: () =>
    ipcRenderer.invoke(IpcChannels.AgentList) as Promise<Agent[]>,
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

  listDirectorMessages: () =>
    ipcRenderer.invoke(IpcChannels.DirectorList) as Promise<DirectorMessage[]>,
  sendToDirector: (body, mode, attachments) =>
    ipcRenderer.invoke(
      IpcChannels.DirectorSend,
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
  abortDirector: () =>
    ipcRenderer.invoke(IpcChannels.DirectorAbort) as Promise<{ ok: true }>,

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
};

contextBridge.exposeInMainWorld('api', api);
