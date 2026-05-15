import { ipcMain, app } from 'electron';
import { IpcChannels, type AppPingResponse, type Settings } from '../shared/ipc';
import { readSettings, writeSettings } from './settings';

const startedAt = Date.now();

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
}
