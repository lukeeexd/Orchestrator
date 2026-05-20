import { BrowserWindow, dialog, ipcMain } from 'electron';
import {
  IpcChannels,
  type PickWorkspaceResponse,
  type SpawnAgentResponse,
} from '../../shared/ipc';
import type {
  Agent,
  EffortLevel,
  SpawnAgentRequest,
} from '../../shared/types';
import { isEffortLevel } from '../../shared/efforts';
import {
  abortAgent,
  forkAgent,
  redirectAgent,
  registry,
  spawnAgent,
} from '../agents/runner';
import { deleteAgent } from '../persistence';
import { assertWorkspaceMatchesProject } from '../security/workspace';
import type { IpcContext } from './_shared';
import { validated } from './_shared';
import {
  forkAgentRequestSchema,
  redirectAgentRequestSchema,
  spawnAgentRequestSchema,
} from './_schemas';

/**
 * The agent sinks (onAgent / onLog / onPatch) are shared between many
 * runner-side functions (spawn / redirect / fork / abort). Exposed so
 * the director module's DirectorAcceptPlan handler can hand the same
 * sinks to the runner spawns it triggers.
 */
export type AgentSinks = ReturnType<typeof makeAgentSinks>;

function makeAgentSinks(ctx: IpcContext) {
  return {
    onAgent: (agent: Agent) =>
      ctx.broadcast(IpcChannels.AgentEventAgent, {
        projectId: agent.projectId,
        agent,
      }),
    onLog: (
      agentId: string,
      line: import('../../shared/types').LogLine,
    ) => {
      const entry = registry.get(agentId);
      // M13: agent gone from the registry → nothing to dispatch to.
      // Previously we broadcast with projectId='' which the renderer
      // silently filtered out, hiding the late line entirely. With
      // the early return that's now explicit.
      if (!entry) return;
      ctx.broadcast(IpcChannels.AgentEventLog, {
        projectId: entry.agent.projectId,
        agentId,
        line,
      });
    },
    onPatch: (agentId: string, patch: Partial<Agent>) => {
      const entry = registry.get(agentId);
      if (!entry) return;
      ctx.broadcast(IpcChannels.AgentEventPatch, {
        projectId: entry.agent.projectId,
        agentId,
        patch,
      });
    },
  };
}

export function registerAgentsHandlers(ctx: IpcContext): AgentSinks {
  const agentSinks = makeAgentSinks(ctx);

  ipcMain.handle(
    IpcChannels.AgentList,
    (_event, projectId: string): Agent[] => registry.listForProject(projectId),
  );

  validated(
    IpcChannels.AgentSpawn,
    spawnAgentRequestSchema,
    async (_event, req): Promise<SpawnAgentResponse> => {
      // C2: pin the cwd to the project's stored workspace so a
      // compromised renderer can't redirect a spawn into C:\Users\
      // or a UNC mount. Throws WorkspaceRejected -> propagates as
      // a rejected IPC promise the renderer's catch already handles.
      const typed = req as SpawnAgentRequest;
      const validatedWs = assertWorkspaceMatchesProject(
        typed.projectId,
        typed.workspace,
      );
      const result = await spawnAgent(
        { ...typed, workspace: validatedWs },
        agentSinks,
      );
      return { ok: true, agentId: result.agentId };
    },
  );

  ipcMain.handle(
    IpcChannels.AgentAbort,
    async (_event, id: string): Promise<{ ok: boolean }> => {
      // Routed through runner.abortAgent so it acquires the
      // per-agent lock — otherwise an abort racing a redirect's
      // controller-swap can land on the pre-swap controller and
      // the post-swap run continues unaffected.
      return abortAgent(id, agentSinks);
    },
  );

  ipcMain.handle(
    IpcChannels.AgentRemove,
    (_event, id: string): { ok: boolean } => {
      const entry = registry.get(id);
      // M13: capture projectId from the registry entry BEFORE
      // removing; without it we'd broadcast with '' and the
      // renderer's per-project filter would drop the event,
      // leaving the row visually orphaned until project switch.
      // If the entry doesn't exist there's nothing to remove and
      // nothing to broadcast.
      if (!entry) return { ok: false };
      const projectId = entry.agent.projectId;
      const ok = registry.remove(id);
      if (ok) {
        deleteAgent(id);
        ctx.broadcast(IpcChannels.AgentEventRemove, { projectId, agentId: id });
      }
      return { ok };
    },
  );

  validated(
    IpcChannels.AgentRedirect,
    redirectAgentRequestSchema,
    async (_event, req): Promise<{ ok: boolean; error?: string }> => {
      return redirectAgent(
        req as import('../../shared/types').RedirectAgentRequest,
        agentSinks,
      );
    },
  );

  validated(
    IpcChannels.AgentFork,
    forkAgentRequestSchema,
    async (
      _event,
      req,
    ): Promise<{ ok: boolean; agentId?: string; error?: string }> => {
      return forkAgent(
        req as import('../../shared/types').ForkAgentRequest,
        agentSinks,
      );
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

  return agentSinks;
}
