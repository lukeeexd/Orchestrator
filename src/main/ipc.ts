import { ipcMain, app, BrowserWindow, dialog } from 'electron';
import {
  IpcChannels,
  type AcceptPlanRequest,
  type AcceptPlanResponse,
  type AppPingResponse,
  type PickWorkspaceResponse,
  type Settings,
  type SpawnAgentResponse,
} from '../shared/ipc';
import type { Agent, DirectorMessage, SpawnAgentRequest } from '../shared/types';
import { readSettings, writeSettings } from './settings';
import { spawnAgent, registry, awaitCompletion } from './agents/runner';
import * as director from './director/runner';
import { deleteAgent } from './persistence';

const startedAt = Date.now();

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

export function registerIpcHandlers(): void {
  // Wire the Director's sinks to broadcast events to the renderer.
  director.setSinks({
    onMessage: (message) =>
      broadcast(IpcChannels.DirectorEventMessage, { message }),
    onPatch: (id, patch) =>
      broadcast(IpcChannels.DirectorEventPatch, { id, patch }),
  });

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
    IpcChannels.AgentRemove,
    (_event, id: string): { ok: boolean } => {
      const ok = registry.remove(id);
      if (ok) {
        deleteAgent(id);
        broadcast(IpcChannels.AgentEventRemove, { agentId: id });
      }
      return { ok };
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

  ipcMain.handle(IpcChannels.DirectorList, (): DirectorMessage[] => {
    return director.listMessages();
  });

  ipcMain.handle(
    IpcChannels.DirectorSend,
    (
      _event,
      body: string,
      mode: import('../shared/types').DirectorMode,
    ): { ok: true } => {
      director.sendFromUser(body, mode);
      return { ok: true };
    },
  );

  ipcMain.handle(IpcChannels.DirectorAbort, (): { ok: true } => {
    director.abort();
    return { ok: true };
  });

  ipcMain.handle(
    IpcChannels.DirectorAcceptPlan,
    async (
      _event,
      req: AcceptPlanRequest,
    ): Promise<AcceptPlanResponse> => {
      const sinks = {
        onAgent: (agent: Agent) =>
          broadcast(IpcChannels.AgentEventAgent, { agent }),
        onLog: (agentId: string, line: import('../shared/types').LogLine) =>
          broadcast(IpcChannels.AgentEventLog, { agentId, line }),
        onPatch: (agentId: string, patch: Partial<Agent>) =>
          broadcast(IpcChannels.AgentEventPatch, { agentId, patch }),
      };
      // Spawn the first agent so the user sees something happen immediately,
      // then ack the plan to the Director so the chat shows "Spawned N
      // agents · pm-01 · coder-01 · qa-01" up front. The remaining agents
      // spawn sequentially as each predecessor reaches a terminal state.
      const spawned: { id: string; name: string }[] = [];
      const firstId = req.rows.length > 0
        ? await spawnAgent(
            {
              role: req.rows[0].role,
              task: req.rows[0].task,
              workspace: req.workspace,
              spawnedBy: 'director',
            },
            sinks,
          )
        : null;
      if (firstId) {
        const e = registry.get(firstId.agentId);
        spawned.push({
          id: firstId.agentId,
          name: e?.agent.name ?? req.rows[0].name,
        });
      }
      // Speculatively reserve names for the rest so the system message is
      // accurate. Actual agents are created in the background loop below.
      const reservedNames = [
        ...spawned.map((s) => s.name),
        ...req.rows.slice(1).map((r) => r.name),
      ];
      director.acknowledgePlanAccepted(req.rows, reservedNames);

      // Sequential tail: await each predecessor before spawning the next.
      void (async () => {
        for (let i = 1; i < req.rows.length; i++) {
          const prev = spawned[spawned.length - 1];
          if (prev) await awaitCompletion(prev.id);
          const row = req.rows[i];
          const r = await spawnAgent(
            {
              role: row.role,
              task: row.task,
              workspace: req.workspace,
              spawnedBy: 'director',
            },
            sinks,
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
