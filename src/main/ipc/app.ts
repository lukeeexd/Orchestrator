import fs from 'node:fs';
import path from 'node:path';
import { app, ipcMain, shell } from 'electron';
import {
  IpcChannels,
  type AppPingResponse,
} from '../../shared/ipc';
import { getCliStatus } from '../cli/status';
import { settingsFilePath, writeSettings } from '../settings';
import { assertValidWorkspacePath } from '../security/workspace';

const startedAt = Date.now();

export function registerAppHandlers(): void {
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
        const fsMod = await import('node:fs');
        if (!fsMod.existsSync(p)) writeSettings({});
        shell.showItemInFolder(p);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.AppHasWorkspaceMd,
    (_event, workspace: string): boolean => {
      // P2: onboarding banner trigger. We validate the workspace
      // through the same path-safety guard the spawn handlers use
      // so a compromised renderer can't probe arbitrary disk paths
      // by asking "does this file exist?". Invalid workspace →
      // return false (no banner shown).
      if (typeof workspace !== 'string' || workspace.length === 0) {
        return false;
      }
      try {
        const validated = assertValidWorkspacePath(workspace);
        return fs.existsSync(path.join(validated, 'WORKSPACE.md'));
      } catch {
        return false;
      }
    },
  );
}
