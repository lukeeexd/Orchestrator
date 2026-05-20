import { ipcMain } from 'electron';
import { IpcChannels } from '../../shared/ipc';
import { getSpendSummary } from '../spend';
import { listHistory } from '../history';
import { listSlashCommands } from '../commands';
import { listSkills, writeSkill } from '../skills';
import { quitAndInstallUpdate } from '../updater';
import type { IpcContext } from './_shared';

/**
 * Single-channel handlers that don't justify their own module —
 * Spend, History, Commands, Skills, Updater. Each is a thin pass-through
 * to the underlying module; grouping them keeps the file tree from
 * sprawling.
 */
export function registerMiscHandlers(_ctx: IpcContext): void {
  ipcMain.handle(
    IpcChannels.SpendGet,
    (): import('../../shared/types').SpendSummary => getSpendSummary(),
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
}
