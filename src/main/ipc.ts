import path from 'node:path';
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
  EffortLevel,
  Project,
  SpawnAgentRequest,
} from '../shared/types';
import { readSettings, writeSettings, settingsFilePath } from './settings';
import { getClaudeCliStatus, getCliStatus } from './cli/status';
import { getSpendSummary } from './spend';
import { listHistory } from './history';
import { listSlashCommands } from './commands';
import { listSkills, writeSkill } from './skills';
import { quitAndInstallUpdate } from './updater';
import {
  spawnAgent,
  redirectAgent,
  forkAgent,
  registry,
  awaitCompletion,
} from './agents/runner';
import * as director from './director/runner';
import { deleteAgent } from './persistence';
import {
  describeAttachments,
  disposePastedFile,
  pasteTempDir,
  readAttachmentAsDataUrl,
  savePastedImage,
  supportedAttachmentExtensions,
} from './attachments';
import * as marketplace from './marketplace';
import type {
  MarketplaceBundleView,
  MarketplaceSourceView,
  MarketplaceSubscriptionView,
} from '../shared/ipc';
import {
  MARKETPLACE_DEFAULT_SOURCE_ID,
  MARKETPLACE_GLOBAL_SCOPE_ID,
} from '../shared/ipc';
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
  setProjectDirectorProvider,
  setProjectMcpConfig,
  setProjectRoleTools,
  setProjectWorkspace,
} from './projects';
import { isEffortLevel } from '../shared/efforts';

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
    IpcChannels.AppCliStatus,
    (): { available: boolean; version: string | null } => getClaudeCliStatus(),
  );

  ipcMain.handle(
    IpcChannels.AppCliStatusByProvider,
    (
      _event,
      provider: import('../shared/types').Provider,
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
    IpcChannels.SpendGet,
    (): import('../shared/types').SpendSummary => getSpendSummary(),
  );

  ipcMain.handle(
    IpcChannels.HistoryList,
    (): import('../shared/types').HistoryRow[] => listHistory(),
  );

  ipcMain.handle(
    IpcChannels.CommandsList,
    (
      _event,
      projectId: string | null,
    ): import('../shared/commands').SlashCommand[] =>
      listSlashCommands(projectId),
  );

  ipcMain.handle(
    IpcChannels.SkillsList,
    (_event, projectId: string): import('../shared/ipc').SkillEntry[] =>
      listSkills(projectId),
  );

  ipcMain.handle(
    IpcChannels.SkillsSet,
    (
      _event,
      projectId: string,
      key: import('../shared/types').SkillKey,
      content: string,
    ): { ok: boolean; entry?: import('../shared/ipc').SkillEntry; error?: string } => {
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
    (
      _event,
      name: string,
      workspace: string,
      provider?: import('../shared/types').Provider,
    ): Project => {
      const project = createProject(name, workspace, provider ?? 'claude');
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
        broadcast(IpcChannels.MarketplaceEventSubscriptionsChanged, {
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
    IpcChannels.ProjectSetDirectorProvider,
    (
      _event,
      id: string,
      provider: import('../shared/types').Provider | null,
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
    IpcChannels.ProjectSetMcpConfig,
    (
      _event,
      id: string,
      config: string | null,
    ): { ok: boolean; error?: string } => {
      // Validate the payload parses as JSON before persisting — a bad
      // config string would otherwise wreck every subsequent spawn for
      // the project. Empty / null clears the config (no validation).
      if (config && config.trim().length > 0) {
        try {
          JSON.parse(config);
        } catch (e) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : 'invalid JSON',
          };
        }
      }
      setProjectMcpConfig(id, config);
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
    (_event, id: string): { ok: boolean } => {
      const ok = registry.abort(id);
      if (ok) {
        const patch: Partial<Agent> = {
          status: 'aborted',
          statusLabel: 'Aborted',
        };
        registry.patch(id, patch);
        agentSinks.onPatch(id, patch);
      }
      return { ok };
    },
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
    // Filter the dialog to types we can actually do something with —
    // text files inline as code blocks, images flow through as vision
    // content blocks, PDFs as document blocks. Anything else used to
    // sneak through and chip as 'unsupported', wasting a click.
    const result = await dialog.showOpenDialog(win, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Supported attachments',
          extensions: supportedAttachmentExtensions(),
        },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { attachments: [] };
    }
    return { attachments: describeAttachments(result.filePaths) };
  });

  ipcMain.handle(
    IpcChannels.AttachmentSavePaste,
    (_event, base64: string, mediaType: string) => {
      // Per-app subdir under the OS temp so we don't trip on collisions
      // with other apps. App-startup sweep handles long-term hygiene;
      // per-chip dispose (below) handles the immediate "user clicked ×"
      // case.
      return savePastedImage(pasteTempDir(), base64, mediaType);
    },
  );

  ipcMain.handle(
    IpcChannels.AttachmentReadThumb,
    (_event, target: string): string => {
      // Gateway lives inside readAttachmentAsDataUrl — only image
      // extensions get served, oversize / missing / non-file paths
      // return an empty string and the renderer falls back to the
      // generic icon.
      return readAttachmentAsDataUrl(target);
    },
  );

  ipcMain.handle(
    IpcChannels.AttachmentDescribePaths,
    (_event, paths: string[]) => {
      // Wraps describeAttachments so the drag-drop handler can validate
      // non-image files (text, PDF) the same way the picker does. Image
      // drops go through savePastedImage instead — we don't have a
      // ready disk path for an in-memory blob.
      return describeAttachments(Array.isArray(paths) ? paths : []);
    },
  );

  ipcMain.handle(
    IpcChannels.AttachmentDispose,
    (_event, target: string): { ok: boolean } => {
      // disposePastedFile rejects anything outside our managed subdir,
      // so it's safe for the renderer to call this for every chip
      // removal — picked attachments outside the subdir are silently
      // ignored.
      return { ok: disposePastedFile(pasteTempDir(), target) };
    },
  );

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
    IpcChannels.DirectorWipe,
    (_event, projectId: string): { ok: true } => {
      director.wipeSession(projectId);
      broadcast(IpcChannels.DirectorEventCleared, { projectId });
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

      // Attachments from the user message that prompted this plan flow
      // to every agent the plan auto-spawns. Without this the Director
      // can see (and describe) a pasted screenshot but the coder/qa/etc
      // agents receive only the plan's text and never the image — so the
      // Director can say "look at the screenshot" and the worker has
      // no screenshot to look at.
      const planAttachments =
        req.attachments && req.attachments.length > 0
          ? req.attachments
          : undefined;

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
                // Per-row provider override (mixed-provider plans).
                // Undefined → spawnAgent falls back to the project's
                // default, same behaviour as before this field existed.
                ...(req.rows[0].provider
                  ? { provider: req.rows[0].provider }
                  : {}),
                ...(planAttachments ? { attachments: planAttachments } : {}),
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
              ...(row.provider ? { provider: row.provider } : {}),
              ...(planAttachments ? { attachments: planAttachments } : {}),
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

  // ─────────────────────── Skill marketplace ──────────────────────

  function sourceView(row: marketplace.SkillSourceRow): MarketplaceSourceView {
    return {
      id: row.id,
      repo: row.repo,
      defaultBranch: row.defaultBranch,
      enabled: row.enabled,
      addedAt: row.addedAt,
      lastSyncAt: row.lastSyncAt,
      lastSyncSha: row.lastSyncSha,
    };
  }

  ipcMain.handle(IpcChannels.MarketplaceListSources, (): MarketplaceSourceView[] =>
    marketplace.listSources().map(sourceView),
  );

  ipcMain.handle(
    IpcChannels.MarketplaceListBundles,
    (_event, sourceId: string): MarketplaceBundleView[] =>
      marketplace.loadBundles(sourceId).map((b) => ({
        id: b.id,
        source: b.source,
        description: b.description,
        version: b.version,
        category: b.category,
        keywords: b.keywords,
      })),
  );

  ipcMain.handle(
    IpcChannels.MarketplaceListSubscriptions,
    (_event, projectId: string): MarketplaceSubscriptionView[] =>
      marketplace.listSubscriptions(projectId).map((s) => ({
        projectId: s.projectId,
        sourceId: s.sourceId,
        bundleId: s.bundleId,
        subscribedAt: s.subscribedAt,
        installedVersion: s.installedVersion,
        roles: s.roles,
        selectedSkills: s.selectedSkills,
        scope:
          s.projectId === MARKETPLACE_GLOBAL_SCOPE_ID
            ? ('global' as const)
            : ('project' as const),
      })),
  );

  ipcMain.handle(
    IpcChannels.MarketplaceSubscribe,
    (
      _event,
      projectId: string,
      sourceId: string,
      bundleId: string,
    ): { ok: boolean; error?: string } => {
      const bundle = marketplace.findBundle(sourceId, bundleId);
      if (!bundle) {
        return {
          ok: false,
          error: 'bundle not found — has the source been synced?',
        };
      }
      marketplace.subscribeBundle(
        projectId,
        sourceId,
        bundleId,
        bundle.version,
      );
      broadcast(IpcChannels.MarketplaceEventSubscriptionsChanged, {
        projectId,
      });
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.MarketplaceUnsubscribe,
    (
      _event,
      projectId: string,
      sourceId: string,
      bundleId: string,
    ): { ok: true } => {
      marketplace.unsubscribeBundle(projectId, sourceId, bundleId);
      broadcast(IpcChannels.MarketplaceEventSubscriptionsChanged, {
        projectId,
      });
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.MarketplaceRefresh,
    async (
      _event,
      sourceId: string,
    ): Promise<{
      ok: boolean;
      sha?: string;
      changed?: boolean;
      error?: string;
    }> => {
      const source = marketplace.getSource(sourceId);
      if (!source) return { ok: false, error: 'source not found' };
      broadcast(IpcChannels.MarketplaceEventSourcePatch, {
        sourceId,
        patch: { syncing: true, syncError: undefined },
      });
      try {
        const { sha, changed } = await marketplace.syncSource(source);
        const syncedAt = Date.now();
        marketplace.recordSourceSync(sourceId, sha, syncedAt);
        broadcast(IpcChannels.MarketplaceEventSourcePatch, {
          sourceId,
          patch: {
            syncing: false,
            lastSyncAt: syncedAt,
            lastSyncSha: sha,
            syncError: undefined,
          },
        });
        return { ok: true, sha, changed };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        broadcast(IpcChannels.MarketplaceEventSourcePatch, {
          sourceId,
          patch: { syncing: false, syncError: msg },
        });
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.MarketplaceAckUpdate,
    (
      _event,
      projectId: string,
      sourceId: string,
      bundleId: string,
    ): { ok: true } => {
      const bundle = marketplace.findBundle(sourceId, bundleId);
      if (bundle) {
        marketplace.acknowledgeBundleVersion(
          projectId,
          sourceId,
          bundleId,
          bundle.version,
        );
        broadcast(IpcChannels.MarketplaceEventSubscriptionsChanged, {
          projectId,
        });
      }
      return { ok: true };
    },
  );

  /**
   * Normalize a user-typed repo string into the canonical "owner/repo"
   * form we use as a source id. Accepts pasted https URLs, trailing
   * slashes, .git suffixes. Returns null if the result isn't a plausible
   * GitHub slug.
   */
  function normalizeRepo(input: string): string | null {
    let s = input.trim();
    s = s.replace(/^https?:\/\/github\.com\//i, '');
    s = s.replace(/\/+$/, '');
    s = s.replace(/\.git$/i, '');
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s)) return null;
    return s;
  }

  ipcMain.handle(
    IpcChannels.MarketplaceAddSource,
    async (
      _event,
      repo: string,
      branch?: string,
    ): Promise<{ ok: boolean; sourceId?: string; error?: string }> => {
      const normalized = normalizeRepo(repo);
      if (!normalized) {
        return {
          ok: false,
          error: 'Repo must be in the form "owner/repo".',
        };
      }
      const defaultBranch =
        branch && branch.trim().length > 0 ? branch.trim() : 'main';
      const inserted = marketplace.ensureSource({
        id: normalized,
        repo: normalized,
        defaultBranch,
      });
      if (!inserted) {
        return {
          ok: false,
          error: `Source "${normalized}" is already added.`,
        };
      }
      // Run the first sync inline so a bad repo / missing branch / git
      // error surfaces in the modal rather than leaving the user with a
      // broken-looking source row. Roll back the row on failure.
      const row = marketplace.getSource(normalized);
      if (!row) {
        return { ok: false, error: 'failed to read back inserted source' };
      }
      try {
        const { sha } = await marketplace.syncSource(row);
        marketplace.recordSourceSync(normalized, sha, Date.now());
        broadcast(IpcChannels.MarketplaceEventSourcesChanged, undefined);
        return { ok: true, sourceId: normalized };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        marketplace.removeSource(normalized);
        broadcast(IpcChannels.MarketplaceEventSourcesChanged, undefined);
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.MarketplaceGetChangelog,
    (
      _event,
      sourceId: string,
      fromVersion: string | null,
      toVersion: string,
    ): marketplace.ChangelogEntry[] =>
      marketplace.getSourceChangelog(sourceId, fromVersion, toVersion),
  );

  ipcMain.handle(
    IpcChannels.MarketplaceListBundleSkills,
    (
      _event,
      sourceId: string,
      bundleId: string,
    ): marketplace.BundleSkillInfo[] =>
      marketplace.listBundleSkills(sourceId, bundleId),
  );

  ipcMain.handle(
    IpcChannels.MarketplaceSetSkills,
    (
      _event,
      projectId: string,
      sourceId: string,
      bundleId: string,
      skills: marketplace.SelectedSkills,
    ): { ok: true } => {
      // Defensive: the renderer is trusted, but the IPC boundary is
      // the right place to coerce shapes so a malformed call can't
      // poison the column. Three valid forms:
      //   null         → all skills
      //   string[]     → flat (every role gets these)
      //   { [r]: [] }  → per-role
      let sanitized: marketplace.SelectedSkills = null;
      if (Array.isArray(skills)) {
        sanitized = skills.filter(
          (s): s is string => typeof s === 'string' && s.length > 0,
        );
      } else if (skills && typeof skills === 'object') {
        const map: Record<string, string[]> = {};
        for (const [role, list] of Object.entries(skills)) {
          if (!Array.isArray(list)) continue;
          map[role] = list.filter(
            (s): s is string => typeof s === 'string' && s.length > 0,
          );
        }
        sanitized = map;
      }
      marketplace.setSubscriptionSkills(
        projectId,
        sourceId,
        bundleId,
        sanitized,
      );
      broadcast(IpcChannels.MarketplaceEventSubscriptionsChanged, {
        projectId,
      });
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.MarketplaceSetSourceEnabled,
    (
      _event,
      sourceId: string,
      enabled: boolean,
    ): { ok: true } => {
      marketplace.setSourceEnabled(sourceId, !!enabled);
      // Source-row patch covers the per-row state in the renderer; a
      // sourcesChanged broadcast would over-trigger a full reload.
      // The renderer's per-row patcher already handles this kind of
      // update.
      broadcast(IpcChannels.MarketplaceEventSourcePatch, {
        sourceId,
        patch: { enabled },
      });
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.MarketplaceRemoveSource,
    (_event, sourceId: string): { ok: boolean; error?: string } => {
      if (sourceId === MARKETPLACE_DEFAULT_SOURCE_ID) {
        return {
          ok: false,
          error:
            'The default source cannot be removed (it would be re-seeded on the next launch). Disable it instead.',
        };
      }
      const removed = marketplace.removeSource(sourceId);
      if (!removed) {
        return { ok: false, error: 'source not found' };
      }
      broadcast(IpcChannels.MarketplaceEventSourcesChanged, undefined);
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.MarketplaceMoveScope,
    (
      _event,
      sourceId: string,
      bundleId: string,
      fromProjectId: string,
      toProjectId: string,
    ): { ok: boolean; error?: string } => {
      const moved = marketplace.moveSubscription(
        sourceId,
        bundleId,
        fromProjectId,
        toProjectId,
      );
      if (!moved) {
        return {
          ok: false,
          error: 'no subscription to move at the source scope',
        };
      }
      // Notify both scopes so the renderer's two parallel calls
      // (project + global) both refresh.
      broadcast(IpcChannels.MarketplaceEventSubscriptionsChanged, {
        projectId: fromProjectId,
      });
      broadcast(IpcChannels.MarketplaceEventSubscriptionsChanged, {
        projectId: toProjectId,
      });
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.MarketplaceSetRoles,
    (
      _event,
      projectId: string,
      sourceId: string,
      bundleId: string,
      roles: string[] | null,
    ): { ok: true } => {
      // Defensive: ignore non-string entries in case the renderer
      // hands us something weird; we'd rather store [] than corrupt
      // the JSON. null passes through cleanly = "all roles".
      const sanitized = roles
        ? roles.filter((r): r is string => typeof r === 'string')
        : null;
      marketplace.setSubscriptionRoles(
        projectId,
        sourceId,
        bundleId,
        sanitized,
      );
      broadcast(IpcChannels.MarketplaceEventSubscriptionsChanged, {
        projectId,
      });
      return { ok: true };
    },
  );
}
