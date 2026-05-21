import { ipcMain, shell } from 'electron';
import { IpcChannels } from '../../shared/ipc';
import { getSpendSummary } from '../spend';
import { getSpendRecommendations } from '../spendRecommendations';
import { listHistory } from '../history';
import { listSlashCommands } from '../commands';
import { listSkills, writeSkill } from '../skills';
import { quitAndInstallUpdate } from '../updater';
import {
  listCrashes,
  clearCrashes,
  getCrashesFolder,
  recordRendererCrash,
} from '../crashes';

/**
 * Single-channel handlers that don't justify their own module —
 * Spend, History, Commands, Skills, Updater. Each is a thin pass-through
 * to the underlying module; grouping them keeps the file tree from
 * sprawling.
 */
export function registerMiscHandlers(): void {
  ipcMain.handle(
    IpcChannels.SpendGet,
    (): import('../../shared/types').SpendSummary => getSpendSummary(),
  );

  ipcMain.handle(
    IpcChannels.SpendRecommendations,
    (): import('../../shared/types').SpendRecommendation[] =>
      getSpendRecommendations(),
  );

  ipcMain.handle(
    IpcChannels.HistoryList,
    (): import('../../shared/types').HistoryRow[] => listHistory(),
  );

  ipcMain.handle(
    IpcChannels.CommandsList,
    (
      _event,
      projectId: string | null,
    ): import('../../shared/commands').SlashCommand[] =>
      listSlashCommands(projectId),
  );

  ipcMain.handle(
    IpcChannels.SkillsList,
    (_event, projectId: string): import('../../shared/ipc').SkillEntry[] =>
      listSkills(projectId),
  );

  ipcMain.handle(
    IpcChannels.SkillsSet,
    (
      _event,
      projectId: string,
      key: import('../../shared/types').SkillKey,
      content: string,
    ): { ok: boolean; entry?: import('../../shared/ipc').SkillEntry; error?: string } => {
      try {
        const entry = writeSkill(projectId, key, content);
        return { ok: true, entry };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  ipcMain.handle(IpcChannels.UpdaterRestart, (): void => {
    quitAndInstallUpdate();
  });

  ipcMain.handle(
    IpcChannels.UpdaterOpenSecondaryDownload,
    async (_event, url: string): Promise<{ ok: boolean }> => {
      // S6: the URL comes from the secondary updater's broadcast,
      // which fires only for URLs we put into latest.json. Belt-
      // and-suspenders: only honour http/https schemes so a
      // tampered manifest can't trick us into shell-opening a
      // file://, javascript:, or other scheme.
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          return { ok: false };
        }
        await shell.openExternal(url);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.CrashesList,
    (): import('../../shared/types').CrashEntry[] => listCrashes(),
  );

  ipcMain.handle(IpcChannels.CrashesClear, (): { removed: number } => ({
    removed: clearCrashes(),
  }));

  ipcMain.handle(
    IpcChannels.CrashesOpenFolder,
    async (): Promise<{ ok: boolean }> => {
      try {
        await shell.openPath(getCrashesFolder());
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.CrashesRecordRenderer,
    (
      _event,
      payload: {
        name?: string;
        message?: string;
        stack?: string;
        componentStack?: string;
        url?: string;
      },
    ): { ok: boolean } => {
      recordRendererCrash(payload);
      return { ok: true };
    },
  );
}
