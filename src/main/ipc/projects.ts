import { ipcMain } from 'electron';
import {
  IpcChannels,
  MARKETPLACE_GLOBAL_SCOPE_ID,
} from '../../shared/ipc';
import type { EffortLevel, Project } from '../../shared/types';
import { isEffortLevel } from '../../shared/efforts';
import { readSettings } from '../settings';
import * as director from '../director/runner';
import * as marketplace from '../marketplace';
import { extractMcpCommands } from '../security/mcp';
import { assertValidWorkspacePath } from '../security/workspace';
import { scaffoldMcpServer } from '../mcpScaffold';
import {
  createProject,
  deleteProject,
  getActiveProjectId,
  listProjects,
  renameProject,
  setActiveProjectId,
  getProject,
  setProjectAutoBranch,
  setProjectGateCommand,
  setProjectDirectorEffort,
  setProjectDirectorModel,
  setProjectDirectorProvider,
  setProjectMcpConfig,
  setProjectRoleTools,
  setProjectWorkspace,
} from '../projects';
import * as registry from '../agents/registry';
import { listBranches } from '../git';
import type { IpcContext } from './_shared';

export function registerProjectsHandlers(ctx: IpcContext): void {
  ipcMain.handle(IpcChannels.ProjectList, (): Project[] => listProjects());
  ipcMain.handle(IpcChannels.ProjectGetActive, (): string | null =>
    getActiveProjectId(),
  );
  ipcMain.handle(
    IpcChannels.ProjectCreate,
    (
      _event,
      name: string,
      workspace: string,
      provider?: import('../../shared/types').Provider,
    ): Project => {
      // C2: validate the workspace if one was supplied at creation
      // time. The empty string is allowed — a project can be created
      // with no workspace yet (the rail asks the user to pick one
      // before the first spawn) — and the spawn handler's
      // match-against-stored-workspace check catches anything that
      // tries to sneak in later.
      const validatedWs =
        typeof workspace === 'string' && workspace.length > 0
          ? assertValidWorkspacePath(workspace)
          : '';
      const project = createProject(name, validatedWs, provider ?? 'claude');
      // If the user has the "copy globals to new projects" toggle on,
      // snapshot every current global marketplace sub into the new
      // project as a project-scoped clone (preserving its roles +
      // selectedSkills + installedVersion). Lets the user customize
      // per project from a global baseline.
      if (readSettings().copyGlobalSubsToNewProjects) {
        const globals = marketplace.listSubscriptions(
          MARKETPLACE_GLOBAL_SCOPE_ID,
        );
        for (const g of globals) {
          marketplace.subscribeBundle(
            project.id,
            g.sourceId,
            g.bundleId,
            g.installedVersion,
          );
          if (g.roles !== null) {
            marketplace.setSubscriptionRoles(
              project.id,
              g.sourceId,
              g.bundleId,
              g.roles,
            );
          }
          if (g.selectedSkills !== null) {
            marketplace.setSubscriptionSkills(
              project.id,
              g.sourceId,
              g.bundleId,
              g.selectedSkills,
            );
          }
        }
        ctx.broadcast(IpcChannels.MarketplaceEventSubscriptionsChanged, {
          projectId: project.id,
        });
      }
      return project;
    },
  );
  ipcMain.handle(
    IpcChannels.ProjectSetActive,
    (_event, id: string): { ok: true } => {
      setActiveProjectId(id);
      ctx.broadcast(IpcChannels.ProjectEventActiveChanged, { projectId: id });
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
      // C2: validate before writing. Rejects UNC, device-namespace,
      // root-only, and non-existent targets so a malicious or
      // mistyped path can't poison the project record (which would
      // then flow to every subsequent spawn via the match check).
      const validated = assertValidWorkspacePath(workspace);
      setProjectWorkspace(id, validated);
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
    IpcChannels.ProjectSetDirectorProvider,
    (
      _event,
      id: string,
      provider: import('../../shared/types').Provider | null,
    ): { ok: true } => {
      const value =
        provider === 'claude' || provider === 'codex' ? provider : null;
      setProjectDirectorProvider(id, value);
      // The new CLI can't resume the old CLI's session id, so drop the
      // saved Director session and any in-memory state. Chat history
      // stays — the user can still see what was said; the next turn
      // just doesn't have model-side memory of it.
      director.resetSessionForProviderChange(id);
      return { ok: true };
    },
  );
  ipcMain.handle(
    IpcChannels.ProjectSetAutoBranch,
    (_event, id: string, on: unknown): { ok: true } => {
      setProjectAutoBranch(id, on === true);
      return { ok: true };
    },
  );
  ipcMain.handle(
    IpcChannels.ProjectSetGateCommand,
    (_event, id: string, command: unknown): { ok: true } => {
      setProjectGateCommand(id, typeof command === 'string' ? command : '');
      return { ok: true };
    },
  );
  ipcMain.handle(
    IpcChannels.GitListBranches,
    (
      _event,
      projectId: string,
    ): { branches: string[]; current: string | null } => {
      // F14 base-branch picker. Resolve workspace internally (the
      // renderer never gets to pick the cwd directly) so the call
      // is fully scoped to the project row in the DB.
      const proj = getProject(projectId);
      if (!proj?.workspace) return { branches: [], current: null };
      return listBranches(proj.workspace);
    },
  );
  ipcMain.handle(
    IpcChannels.ProjectSetMcpConfig,
    (
      _event,
      id: string,
      config: string | null,
    ): { ok: boolean; error?: string; commands?: string[] } => {
      // H3: parse + extract the commands the config would spawn so
      // we can return them to the renderer (for a confirmation
      // step) and surface them in the Director chat as a persistent
      // audit trail. `claude --mcp-config` literally spawns
      // `mcpServers[*].command`, so a renderer that can write the
      // config can pick the binary that runs on every agent spawn.
      let commands: string[] = [];
      if (config && config.trim().length > 0) {
        try {
          commands = extractMcpCommands(config);
        } catch (e) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : 'invalid JSON',
          };
        }
      }
      try {
        setProjectMcpConfig(id, config);
      } catch (e) {
        // M13: setProjectMcpConfig now throws on disk-write
        // failure instead of swallowing — surface it so the user
        // sees why their MCP servers won't load next spawn.
        return {
          ok: false,
          error: e instanceof Error ? e.message : 'mcp-config write failed',
        };
      }
      // Audit trail in the Director chat so the user has a visible
      // record that "X started running on each spawn at HH:MM:SS".
      // Skipped on clear (commands == [] and config null).
      if (commands.length > 0) {
        const list = commands.join(', ');
        director.notifySystem(
          id,
          `MCP config updated. The following commands will execute on every Claude agent spawn for this project: ${list}`,
        );
      } else if (!config) {
        director.notifySystem(id, 'MCP config cleared.');
      }
      return { ok: true, commands };
    },
  );

  ipcMain.handle(
    IpcChannels.ProjectPreviewMcpConfigCommands,
    (_event, config: string | null): { commands: string[] } => {
      if (!config || config.trim().length === 0) return { commands: [] };
      try {
        return { commands: extractMcpCommands(config) };
      } catch {
        return { commands: [] };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.ProjectScaffoldMcpServer,
    (
      _event,
      input: import('../../shared/ipc').McpScaffoldRequest,
    ): import('../../shared/ipc').McpScaffoldResult => {
      return scaffoldMcpServer(input);
    },
  );
  ipcMain.handle(
    IpcChannels.ProjectSetRoleTools,
    (
      _event,
      id: string,
      roleTools: Partial<
        Record<import('../../shared/types').AgentRole, string[]>
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
}
