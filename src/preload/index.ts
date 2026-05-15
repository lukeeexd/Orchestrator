import { contextBridge, ipcRenderer } from 'electron';
import {
  IpcChannels,
  type AppPingResponse,
  type OrchestratorApi,
  type Settings,
} from '../shared/ipc';

const api: OrchestratorApi = {
  ping: () => ipcRenderer.invoke(IpcChannels.AppPing) as Promise<AppPingResponse>,
  getSettings: () => ipcRenderer.invoke(IpcChannels.SettingsGet) as Promise<Settings>,
  setSettings: (next) =>
    ipcRenderer.invoke(IpcChannels.SettingsSet, next) as Promise<Settings>,
};

contextBridge.exposeInMainWorld('api', api);
