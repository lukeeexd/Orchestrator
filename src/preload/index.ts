import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IpcChannels,
  type AgentEventAgentPayload,
  type AgentEventLogPayload,
  type AgentEventPatchPayload,
  type AppPingResponse,
  type OrchestratorApi,
  type PickWorkspaceResponse,
  type Settings,
  type SpawnAgentResponse,
} from '../shared/ipc';
import type { Agent, SpawnAgentRequest } from '../shared/types';

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
  pickWorkspace: () =>
    ipcRenderer.invoke(IpcChannels.AgentPickWorkspace) as Promise<PickWorkspaceResponse>,

  onAgent: (cb) => subscribe<AgentEventAgentPayload>(IpcChannels.AgentEventAgent, cb),
  onLog: (cb) => subscribe<AgentEventLogPayload>(IpcChannels.AgentEventLog, cb),
  onPatch: (cb) =>
    subscribe<AgentEventPatchPayload>(IpcChannels.AgentEventPatch, cb),
};

contextBridge.exposeInMainWorld('api', api);
