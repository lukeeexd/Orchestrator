import { ipcMain, app, BrowserWindow, dialog, shell } from 'electron';
import {
  IpcChannels,
  type AcceptPlanRequest,
  type AcceptPlanResponse,
  type AppPingResponse,
  type PickWorkspaceResponse,
  type Settings,
  type SpawnAgentResponse,
} from '../shared/ipc';
import type {
  Agent,
  DirectorMessage,
  Project,
  SpawnAgentRequest,
} from '../shared/types';
import { readSettings, writeSettings, settingsFilePath } from './settings';
import {
  spawnAgent,
  redirectAgent,
  forkAgent,
  registry,
  awaitCompletion,
} from './agents/runner';
import * as director from './director/runner';
import { deleteAgent } from './persistence';
import { describeAttachments } from './attachments';
import {
  createProject,
  deleteProject,
  getActiveProjectId,
  getProject,
  listProjects,
  renameProject,
  setActiveProjectId,
  setProjectDirectorEffort,
  setProjectDirectorModel,
  setProjectRoleTools,
  setProjectWorkspace,
} from './projects';
import { isEffortLevel } from '../shared/efforts';
import type { EffortLevel } from '../shared/types';

const startedAt = Date.now();

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

export function registerIpcHandlers(): void {
  director.setSinks({
    onMessage: (projectId, message) =>
      broadcast(IpcChannels.DirectorEventMessage, { projectId, message }),
    onPatch: (projectId, id, patch) =>
      broadcast(IpcChannels.DirectorEventPatch, { projectId, id, patch }),
  });

  ipcMain.handle(IpcChannels.AppPing, (): AppPingResponse => {
    return { ok: true, version: app.getVersion(), startedAt };
  });

  ipcMain.handle(IpcChannels.SettingsGet, (): Settings => readSettings());
  ipcMain.handle(
    IpcChannels.SettingsSet,
    (_event, next: Partial<Settings>): Settings => {
      const merged = writeSettings(next);
      broadcast(IpcChannels.SettingsEventChanged, merged);
      return merged;
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

  // ─────────────────────────── Projects ───────────────────────────
  ipcMain.handle(IpcChannels.ProjectList, (): Project[] => listProjects());
  ipcMain.handle(IpcChannels.ProjectGetActive, (): string | null =>
    getActiveProjectId(),
  );
  ipcMain.handle(
    IpcChannels.ProjectCreate,
    (_event, name: string, workspace: string): Project =>
      createProject(name, workspace),
  );
  ipcMain.handle(
    IpcChannels.ProjectSetActive,
    (_event, id: string): { ok: true } => {
      setActiveProjectId(id);
      broadcast(IpcChannels.ProjectEventActiveChanged, { projectId: id });
      return { ok: true };
    },
  );
  ipcMain.handle(
    IpcChannels.ProjectRename,
    (_event, id: string, name: string): { ok: true } => {
      renameProject(id, name);
      return { ok: true };
    },
  );
  ipcMain.handle(
    IpcChannels.ProjectSetWorkspace,
    (_event, id: string, workspace: string): { ok: true } => {
      setProjectWorkspace(id, workspace);
      return { ok: true };
    },
  );
  ipcMain.handle(
    IpcChannels.ProjectSetDirectorModel,
    (_event, id: string, model: string): { ok: true } => {
      setProjectDirectorModel(id, model);
      return { ok: true };
    },
  );
  ipcMain.handle(
    IpcChannels.ProjectSetDirectorEffort,
    (_event, id: string, effort: EffortLevel | null): { ok: true } => {
      setProjectDirectorEffort(id, isEffortLevel(effort) ? effort : null);
      return { ok: true };
    },
  );
  ipcMain.handle(
    IpcChannels.ProjectSetRoleTools,
    (
      _event,
      id: string,
      roleTools: Partial<
        Record<import('../shared/types').AgentRole, string[]>
      > | null,
    ): { ok: true } => {
      setProjectRoleTools(id, roleTools);
      return { ok: true };
    },
  );
  ipcMain.handle(
    IpcChannels.ProjectDelete,
    (_event, id: string): { ok: true } => {
      // Stop the Director session and remove agents for this project first.
      director.discardSession(id);
      for (const a of registry.listForProject(id)) {
        registry.remove(a.id);
      }
      deleteProject(id);
      return { ok: true };
    },
  );

  // ───────────────────────────── Agents ───────────────────────────
  const agentSinks = {
    onAgent: (agent: Agent) =>
      broadcast(IpcChannels.AgentEventAgent, {
        projectId: agent.projectId,
        agent,
      }),
    onLog: (agentId: string, line: import('../shared/types').LogLine) => {
      const entry = registry.get(agentId);
      broadcast(IpcChannels.AgentEventLog, {
        projectId: entry?.agent.projectId ?? '',
        agentId,
        line,
      });
    },
    onPatch: (agentId: string, patch: Partial<Agent>) => {
      const entry = registry.get(agentId);
      broadcast(IpcChannels.AgentEventPatch, {
        projectId: entry?.agent.projectId ?? '',
        agentId,
        patch,
      });
    },
  };

  ipcMain.handle(
    IpcChannels.AgentList,
    (_event, projectId: string): Agent[] => registry.listForProject(projectId),
  );

  ipcMain.handle(
    IpcChannels.AgentSpawn,
    async (_event, req: SpawnAgentRequest): Promise<SpawnAgentResponse> => {
      const result = await spawnAgent(req, agentSinks);
      return { ok: true, agentId: result.agentId };
    },
  );

  ipcMain.handle(
    IpcChannels.AgentAbort,
    (_event, id: string): { ok: boolean } => ({ ok: registry.abort(id) }),
  );

  ipcMain.handle(
    IpcChannels.AgentRemove,
    (_event, id: string): { ok: boolean } => {
      const entry = registry.get(id);
      const projectId = entry?.agent.projectId ?? '';
      const ok = registry.remove(id);
      if (ok) {
        deleteAgent(id);
        broadcast(IpcChannels.AgentEventRemove, { projectId, agentId: id });
      }
      return { ok };
    },
  );

  ipcMain.handle(
    IpcChannels.AgentRedirect,
    async (
      _event,
      req: import('../shared/types').RedirectAgentRequest,
    ): Promise<{ ok: boolean; error?: string }> => {
      return redirectAgent(req, agentSinks);
    },
  );

  ipcMain.handle(
    IpcChannels.AgentFork,
    async (
      _event,
      req: import('../shared/types').ForkAgentRequest,
    ): Promise<{ ok: boolean; agentId?: string; error?: string }> => {
      return forkAgent(req, agentSinks);
    },
  );

  ipcMain.handle(
    IpcChannels.AgentSetModel,
    (_event, id: string, model: string): { ok: boolean } => {
      const updated = registry.patch(id, { model });
      if (!updated) return { ok: false };
      agentSinks.onPatch(id, { model });
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.AgentSetEffort,
    (_event, id: string, effort: EffortLevel): { ok: boolean } => {
      if (!isEffortLevel(effort)) return { ok: false };
      const updated = registry.patch(id, { effort });
      if (!updated) return { ok: false };
      agentSinks.onPatch(id, { effort });
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.AgentPickWorkspace,
    async (event): Promise<PickWorkspaceResponse> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return { path: null };
      const result = await dialog.showOpenDialog(win, {
        title: 'Choose workspace folder',
        properties: ['openDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { path: null };
      }
      return { path: result.filePaths[0] };
    },
  );

  ipcMain.handle(IpcChannels.AttachmentPick, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { attachments: [] };
    const result = await dialog.showOpenDialog(win, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { attachments: [] };
    }
    return { attachments: describeAttachments(result.filePaths) };
  });

  // ─────────────────────────── Director ───────────────────────────
  ipcMain.handle(
    IpcChannels.DirectorList,
    (_event, projectId: string): DirectorMessage[] =>
      director.listMessages(projectId),
  );

  ipcMain.handle(
    IpcChannels.DirectorSend,
    (
      _event,
      projectId: string,
      body: string,
      mode: import('../shared/types').DirectorMode,
      attachments?: string[],
    ): { ok: true } => {
      director.sendFromUser(projectId, body, mode, attachments);
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.DirectorAbort,
    (_event, projectId: string): { ok: true } => {
      director.abort(projectId);
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.DirectorAckRedirect,
    (
      _event,
      req: {
        projectId: string;
        messageId: string;
        agentName: string;
        ok: boolean;
        error?: string;
      },
    ): { ok: true } => {
      director.acknowledgeRedirect(
        req.projectId,
        req.messageId,
        req.agentName,
        req.ok,
        req.error,
      );
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.DirectorAcceptPlan,
    async (_event, req: AcceptPlanRequest): Promise<AcceptPlanResponse> => {
      // Director auto-spawns inherit the Director's effective model +
      // effort — using the same cascade the Director itself uses
      // (per-project override → settings.defaultDirectorModel/Effort →
      // settings.defaultModel/Effort). Just reading project.directorModel
      // wasn't enough: when the user leaves the Director on the global
      // defaults, project.directorModel is null and agents fall through
      // to the cheap agent defaults — so an Opus 4.7 1M xhigh Director
      // would quietly spawn Sonnet 4.6 high workers.
      const project = getProject(req.projectId);
      const cascadeSettings = readSettings();
      const resolvedDirectorModel =
        project?.directorModel ||
        cascadeSettings.defaultDirectorModel ||
        cascadeSettings.defaultModel;
      const resolvedDirectorEffort =
        project?.directorEffort ||
        cascadeSettings.defaultDirectorEffort ||
        cascadeSettings.defaultEffort;
      const directorOverrides: {
        model?: string;
        effort?: import('../shared/types').EffortLevel;
      } = {
        ...(resolvedDirectorModel ? { model: resolvedDirectorModel } : {}),
        ...(resolvedDirectorEffort ? { effort: resolvedDirectorEffort } : {}),
      };

      const spawned: { id: string; name: string }[] = [];
      const firstId =
        req.rows.length > 0
          ? await spawnAgent(
              {
                projectId: req.projectId,
                role: req.rows[0].role,
                task: req.rows[0].task,
                workspace: req.workspace,
                spawnedBy: 'director',
                ...directorOverrides,
              },
              agentSinks,
            )
          : null;
      if (firstId) {
        const e = registry.get(firstId.agentId);
        spawned.push({
          id: firstId.agentId,
          name: e?.agent.name ?? req.rows[0].name,
        });
      }
      const reservedNames = [
        ...spawned.map((s) => s.name),
        ...req.rows.slice(1).map((r) => r.name),
      ];
      director.acknowledgePlanAccepted(
        req.projectId,
        req.rows,
        reservedNames,
      );

      void (async () => {
        for (let i = 1; i < req.rows.length; i++) {
          const prev = spawned[spawned.length - 1];
          if (prev) await awaitCompletion(prev.id);
          const row = req.rows[i];
          const r = await spawnAgent(
            {
              projectId: req.projectId,
              role: row.role,
              task: row.task,
              workspace: req.workspace,
              spawnedBy: 'director',
              ...directorOverrides,
            },
            agentSinks,
          );
          const e = registry.get(r.agentId);
          spawned.push({
            id: r.agentId,
            name: e?.agent.name ?? row.name,
          });
        }
      })();

      return { spawnedAgentIds: spawned.map((s) => s.id) };
    },
  );
}
