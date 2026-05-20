import { app, ipcMain, shell } from 'electron';
import {
  IpcChannels,
  type AppPingResponse,
} from '../../shared/ipc';
import { getCliStatus } from '../cli/status';
import { settingsFilePath, writeSettings } from '../settings';
import type { IpcContext } from './_shared';

const startedAt = Date.now();

export function registerAppHandlers(_ctx: IpcContext): void {
  ipcMain.handle(IpcChannels.AppPing, (): AppPingResponse => {
    return { ok: true, version: app.getVersion(), startedAt };
  });

  // L4: dropped the parameterless AppCliStatus channel — it was a
  // claude-only convenience the renderer no longer used. Every
  // call site goes through the parameterised AppCliStatusByProvider
  // now.
  ipcMain.handle(
    IpcChannels.AppCliStatusByProvider,
    (
      _event,
      provider: import('../../shared/types').Provider,
    ): { available: boolean; version: string | null } => getCliStatus(provider),
  );

  ipcMain.handle(
    IpcChannels.AppOpenUsage,
    async (): Promise<{ ok: boolean }> => {
      // Hardcoded URL on the main side — preload doesn't accept a URL arg
      // so the renderer can't redirect this anywhere else (e.g. to a
      // phishing lookalike).
      try {
        await shell.openExternal('https://claude.ai/settings/usage');
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.AppShowSettingsFile,
    async (): Promise<{ ok: boolean }> => {
      const p = settingsFilePath();
      // shell.showItemInFolder requires the file to exist; create on first
      // open if a user clicks before saving anything.
      try {
        const fs = await import('node:fs');
        if (!fs.existsSync(p)) writeSettings({});
        shell.showItemInFolder(p);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  );
}
