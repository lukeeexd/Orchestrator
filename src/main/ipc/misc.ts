import { ipcMain, shell, BrowserWindow, dialog } from 'electron';
import { IpcChannels } from '../../shared/ipc';
import { getSpendSummary } from '../spend';
import { getSpendRecommendations } from '../spendRecommendations';
import { forecastPlanCost } from '../spendForecast';
import { listNotes as listLogNotes, setNote as setLogNote } from '../logNotes';
import { exportRunBundle } from '../runBundle';
import {
  listSecrets,
  setSecret,
  deleteSecret,
  readSecretValue,
} from '../secrets';
import { listHistory } from '../history';
import { listSlashCommands } from '../commands';
import { listSkills, writeSkill } from '../skills';
import {
  quitAndInstallUpdate,
  getUpdaterState,
  checkForUpdatesNow,
} from '../updater';
import {
  listCrashes,
  clearCrashes,
  getCrashesFolder,
  recordRendererCrash,
  exportCrashBundle,
} from '../crashes';
import { recordRendererCrashSchema } from './_schemas';
import { validated } from './_shared';
import {
  listProposals as listMemoryProposals,
  approveProposal as approveMemoryProposal,
  rejectProposal as rejectMemoryProposal,
} from '../memoryProposals';
import {
  listDirectory as docsListDirectory,
  readMarkdownFile as docsReadFile,
} from '../markdownBrowser';
import type {
  AgentRole,
  MarkdownFileContent,
  MarkdownListing,
  MemoryProposal,
  MemoryProposalStatus,
} from '../../shared/types';

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
    IpcChannels.SpendForecastPlan,
    (
      _event,
      rows: import('../../shared/types').PlanRow[],
    ): import('../../shared/types').PlanCostForecast =>
      forecastPlanCost(Array.isArray(rows) ? rows : []),
  );

  // ─────────────────────────── F12: log notes ───────────────────────────

  ipcMain.handle(
    IpcChannels.LogNotesList,
    (
      _event,
      agentId: string,
    ): import('../../shared/types').LogNote[] => listLogNotes(agentId),
  );

  ipcMain.handle(
    IpcChannels.LogNotesSet,
    (
      _event,
      agentId: string,
      lineKey: string,
      body: string,
    ): { ok: true } | { ok: false; error: string } => {
      try {
        setLogNote(agentId, lineKey, body);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  // ─────────────────────────── F11: run-bundle export ───────────────────────────

  ipcMain.handle(
    IpcChannels.RunsExportBundle,
    async (
      _event,
      agentIds: string[],
      opts: { scrubSecrets: boolean } | null | undefined,
    ): Promise<
      { ok: true; path: string } | { ok: false; error: string }
    > => {
      // F11: build the .orun zip on disk, then reveal it in Explorer
      // so the user can grab it without hunting through userData.
      // Reveal failure isn't fatal — the path is returned regardless.
      const safeOpts = {
        scrubSecrets: opts?.scrubSecrets !== false,
      };
      const result = exportRunBundle(agentIds, safeOpts);
      if (result.ok && result.path) {
        try {
          shell.showItemInFolder(result.path);
        } catch {
          // best-effort
        }
        return { ok: true, path: result.path };
      }
      return { ok: false, error: result.error ?? 'export failed' };
    },
  );

  // ─────────────────────────── F6: secrets vault ───────────────────────────

  ipcMain.handle(
    IpcChannels.SecretsList,
    (
      _event,
      projectId: string,
    ): import('../../shared/types').SecretListEntry[] =>
      listSecrets(projectId),
  );

  ipcMain.handle(
    IpcChannels.SecretsSet,
    (
      _event,
      projectId: string,
      name: string,
      value: string,
    ): { ok: true } | { ok: false; error: string } => {
      try {
        setSecret(projectId, name, value);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.SecretsDelete,
    (_event, projectId: string, name: string): { ok: true } => {
      deleteSecret(projectId, name);
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.SecretsReveal,
    (
      _event,
      projectId: string,
      name: string,
    ): { ok: true; value: string } | { ok: false; error: string } => {
      const v = readSecretValue(projectId, name);
      if (v === null) return { ok: false, error: 'secret not found' };
      return { ok: true, value: v };
    },
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

  // R-U1 (v0.23.0): expose updater state + manual check to the renderer.
  // GetState is a pure read — Settings calls it on mount to render the
  // current updater diagnostic panel. CheckNow forces an immediate poll
  // bypassing the 10-minute interval; returns the post-call snapshot so
  // the renderer can update its display without waiting for the
  // `state-changed` event (which still fires too).
  ipcMain.handle(
    IpcChannels.UpdaterGetState,
    (): import('../../shared/ipc').UpdaterStateSnapshot => getUpdaterState(),
  );
  ipcMain.handle(
    IpcChannels.UpdaterCheckNow,
    (): import('../../shared/ipc').UpdaterStateSnapshot => checkForUpdatesNow(),
  );

  ipcMain.handle(
    IpcChannels.UpdaterOpenSecondaryDownload,
    async (_event, url: string): Promise<{ ok: boolean }> => {
      // S6: the URL comes from the secondary updater's broadcast,
      // which fires only for URLs we put into latest.json. Belt-
      // and-suspenders: pin scheme AND host so a tampered manifest
      // can't trick us into shell-opening a fake installer hosted
      // on an attacker domain. Allowlist GitHub Releases (the
      // current install URL) — extend the list if the secondary
      // ever signals a different host (R-M9).
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return { ok: false };
        const host = parsed.hostname.toLowerCase();
        const allowed =
          host === 'github.com' ||
          host === 'www.github.com' ||
          host === 'objects.githubusercontent.com';
        if (!allowed) return { ok: false };
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
    IpcChannels.CrashesExportBundle,
    async (
      _event,
      crashId: string,
      opts: { scrubSecrets: boolean } | null | undefined,
    ): Promise<
      { ok: true; path: string } | { ok: false; error: string }
    > => {
      // F9: build the bundle .zip on disk, then reveal it in Explorer
      // so the user can grab it without hunting through the folder.
      // Reveal failure isn't fatal — caller still gets the path.
      const safeOpts = {
        scrubSecrets: opts?.scrubSecrets !== false,
      };
      const result = exportCrashBundle(crashId, safeOpts);
      if (result.ok) {
        try {
          shell.showItemInFolder(result.path);
        } catch {
          // best-effort
        }
      }
      return result;
    },
  );

  validated(
    IpcChannels.CrashesRecordRenderer,
    recordRendererCrashSchema,
    // R-M4: zod-validate the renderer-forwarded crash payload at the
    // boundary so a malformed/oversize record can't reach the disk-
    // write pipeline.
    (_event, payload): { ok: boolean } => {
      recordRendererCrash(payload);
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.MemoryListProposals,
    (
      _event,
      projectId: string,
      role?: AgentRole,
      status?: MemoryProposalStatus,
    ): MemoryProposal[] =>
      listMemoryProposals({
        projectId,
        ...(role ? { role } : {}),
        ...(status ? { status } : {}),
      }),
  );

  ipcMain.handle(
    IpcChannels.MemoryApproveProposal,
    (
      _event,
      id: string,
    ):
      | { ok: true; proposal: MemoryProposal }
      | { ok: false; error: string } => approveMemoryProposal(id),
  );

  ipcMain.handle(
    IpcChannels.MemoryRejectProposal,
    (
      _event,
      id: string,
    ):
      | { ok: true; proposal: MemoryProposal }
      | { ok: false; error: string } => rejectMemoryProposal(id),
  );

  ipcMain.handle(
    IpcChannels.DocsListDirectory,
    (
      _event,
      absPath: string,
    ):
      | { ok: true; listing: MarkdownListing }
      | { ok: false; error: string } => {
      try {
        return { ok: true, listing: docsListDirectory(absPath) };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.DocsReadFile,
    (
      _event,
      absPath: string,
    ):
      | { ok: true; file: MarkdownFileContent }
      | { ok: false; error: string } => {
      try {
        return { ok: true, file: docsReadFile(absPath) };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.DocsPickFolder,
    async (event): Promise<{ path: string | null }> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return { path: null };
      const result = await dialog.showOpenDialog(win, {
        title: 'Pick folder for Docs viewer',
        properties: ['openDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { path: null };
      }
      return { path: result.filePaths[0] };
    },
  );
}
