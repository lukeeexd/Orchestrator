import { ipcMain, app, BrowserWindow, dialog } from 'electron';
import {
  IpcChannels,
  type AppPingResponse,
  type Settings,
  type SpawnAgentResponse,
  type PickWorkspaceResponse,
} from '../shared/ipc';
import type { Agent, SpawnAgentRequest } from '../shared/types';
import { readSettings, writeSettings } from './settings';
import { spawnAgent, registry } from './agents/runner';

const startedAt = Date.now();

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannels.AppPing, (): AppPingResponse => {
    return { ok: true, version: app.getVersion(), startedAt };
  });

  ipcMain.handle(IpcChannels.SettingsGet, (): Settings => {
    return readSettings();
  });

  ipcMain.handle(
    IpcChannels.SettingsSet,
    (_event, next: Partial<Settings>): Settings => {
      return writeSettings(next);
    },
  );

  ipcMain.handle(IpcChannels.AgentList, (): Agent[] => {
    return registry.list();
  });

  ipcMain.handle(
    IpcChannels.AgentSpawn,
    async (_event, req: SpawnAgentRequest): Promise<SpawnAgentResponse> => {
      const result = await spawnAgent(req, {
        onAgent: (agent) => broadcast(IpcChannels.AgentEventAgent, { agent }),
        onLog: (agentId, line) =>
          broadcast(IpcChannels.AgentEventLog, { agentId, line }),
        onPatch: (agentId, patch) =>
          broadcast(IpcChannels.AgentEventPatch, { agentId, patch }),
      });
      return { ok: true, agentId: result.agentId };
    },
  );

  ipcMain.handle(
    IpcChannels.AgentAbort,
    (_event, id: string): { ok: boolean } => {
      return { ok: registry.abort(id) };
    },
  );

  ipcMain.handle(
    IpcChannels.AgentPickWorkspace,
    async (event): Promise<PickWorkspaceResponse> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return { path: null };
      const result = await dialog.showOpenDialog(win, {
        title: 'Choose workspace folder for the agent',
        properties: ['openDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { path: null };
      }
      return { path: result.filePaths[0] };
    },
  );
}
