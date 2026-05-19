import { useEffect, useRef, useState } from 'react';
import type {
  DirectorMessage,
  DirectorMode,
  EffortLevel,
  PlanRow,
  Project,
  Provider,
} from '../shared/types';
import { DEFAULT_EFFORT } from '../shared/efforts';
import { defaultModelForProvider, modelMatchesProvider } from '../shared/models';
import { useLocalStorageState } from './hooks/useLocalStorageState';
import { useAgents } from './hooks/useAgents';
import { useDirector } from './hooks/useDirector';
import { useSettings } from './hooks/useSettings';
import { useProjects } from './hooks/useProjects';
import { useMarketplace } from './hooks/useMarketplace';
import { TopBar, type ViewMode } from './components/TopBar';
import { LeftRail, type RailScreen } from './components/LeftRail';
import { StatusBar } from './components/StatusBar';
import { DirectorPane } from './components/DirectorPane';
import { AgentsPane } from './components/AgentsPane';
import { Drawer } from './components/Drawer';
import { ResizeHandle } from './components/ResizeHandle';
import { PlaceholderScreen } from './components/PlaceholderScreen';
import { SettingsScreen } from './components/SettingsScreen';
import { ToolsScreen } from './components/ToolsScreen';
import { MarketplaceScreen } from './components/MarketplaceScreen';
import { SpendScreen } from './components/SpendScreen';
import { HistoryScreen } from './components/HistoryScreen';
import { CliMissingGate } from './components/CliMissingGate';
import type { BuiltinAction } from '../shared/builtinCommands';
import {
  ProjectTabs,
  NewProjectForm,
  ConfirmDeleteProject,
} from './components/ProjectTabs';

const PLACEHOLDERS: Record<
  Exclude<
    RailScreen,
    'agents' | 'settings' | 'tools' | 'cost' | 'history' | 'marketplace'
  >,
  { title: string; icon: Parameters<typeof PlaceholderScreen>[0]['icon']; body: string }
> = {
  templates: {
    title: 'Templates',
    icon: 'templates',
    body: 'Saved agent fleets. Pick a template, the Director spawns the matching agents with their system prompts and tool allow-lists already wired.',
  },
};

export function App() {
  const [active, setActive] = useState<RailScreen>('agents');
  const [dirW, setDirW] = useLocalStorageState<number>('orchestrator.dirW', 400);
  const [drawerW, setDrawerW] = useLocalStorageState<number>(
    'orchestrator.drawerW',
    460,
  );
  const [mode, setMode] = useLocalStorageState<DirectorMode>(
    'orchestrator.directorMode',
    'auto',
  );
  const [viewMode, setViewMode] = useLocalStorageState<ViewMode>(
    'orchestrator.viewMode',
    'compact',
  );
  const [drawerCollapsed, setDrawerCollapsed] = useLocalStorageState<boolean>(
    'orchestrator.drawerCollapsed',
    false,
  );
  const [showNewProject, setShowNewProject] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [agentCountByProject, setAgentCountByProject] = useState<
    Record<string, number>
  >({});
  // Whether each provider's CLI is on PATH. `null` while we're still
  // probing for the first time. We check both at startup so the gate
  // can be provider-aware — a claude-only user with no codex CLI isn't
  // blocked unless they're sitting on a codex project.
  const [cliStatus, setCliStatus] = useState<Record<Provider, boolean> | null>(
    null,
  );

  useEffect(() => {
    void (async () => {
      const [claudeStatus, codexStatus] = await Promise.all([
        window.api.getCliStatus('claude'),
        window.api.getCliStatus('codex'),
      ]);
      setCliStatus({
        claude: claudeStatus.available,
        codex: codexStatus.available,
      });
    })();
  }, []);

  const { settings } = useSettings();
  const {
    projects,
    activeId: activeProjectId,
    setActive: setActiveProject,
    create: createProject,
    setWorkspace: setProjectWorkspace,
    setDirectorModel: setProjectDirectorModel,
    setDirectorEffort: setProjectDirectorEffort,
    setDirectorProvider: setProjectDirectorProvider,
    setMcpConfig,
    setRoleTools: setProjectRoleTools,
    remove: removeProject,
  } = useProjects();
  const marketplace = useMarketplace(activeProjectId);

  // Transient toast surfacing newly-arrived marketplace bundle updates.
  // The persistent rail badge already shows the count; this is the
  // "hey, something just landed" flash so the user notices without
  // having to glance at the rail.
  const [marketplaceToast, setMarketplaceToast] = useState<{
    count: number;
  } | null>(null);
  // Tracks the last pendingUpdates count we've observed so we only
  // toast on *increases*. null = haven't seen the first reload yet
  // (so we don't toast for updates that were already pending when the
  // app launched).
  const lastSeenPendingUpdatesRef = useRef<number | null>(null);
  useEffect(() => {
    const current = marketplace.pendingUpdates.length;
    const previous = lastSeenPendingUpdatesRef.current;
    lastSeenPendingUpdatesRef.current = current;
    // Initial load → record the count and stay silent.
    if (previous === null) return;
    // Only toast when the count grew, and there's at least one update.
    if (current > previous && current > 0) {
      const newlyAdded = current - previous;
      setMarketplaceToast({ count: newlyAdded });
    }
  }, [marketplace.pendingUpdates.length]);
  // Auto-dismiss after 6s so the toast doesn't linger.
  useEffect(() => {
    if (!marketplaceToast) return;
    const t = setTimeout(() => setMarketplaceToast(null), 6000);
    return () => clearTimeout(t);
  }, [marketplaceToast]);

  const activeProject: Project | null =
    projects.find((p) => p.id === activeProjectId) ?? null;
  const workspace = activeProject?.workspace ?? '';
  // Default chain. Falls through to a provider-appropriate default so a
  // codex project doesn't silently get the global claude default
  // (claude-opus-4-7-1m), which codex would reject as an unknown model.
  const activeProvider = activeProject?.provider ?? 'claude';
  // The Director can opt into a different CLI than the agents via
  // directorProvider. Default → use the project's agent provider, same
  // as before this knob existed.
  const directorProvider =
    activeProject?.directorProvider ?? activeProvider;
  const providerDefaultModel = defaultModelForProvider(activeProvider);
  const directorProviderDefaultModel =
    defaultModelForProvider(directorProvider);
  const fallbackModel =
    activeProvider === 'claude'
      ? settings?.defaultModel ?? providerDefaultModel
      : providerDefaultModel;
  const directorFallbackModel =
    directorProvider === 'claude'
      ? settings?.defaultDirectorModel || directorProviderDefaultModel
      : directorProviderDefaultModel;
  // If the stored directorModel doesn't match the Director's effective
  // provider (e.g. legacy value, or the Director provider was just
  // flipped to one whose model picker hasn't been touched yet), fall
  // through to the provider-appropriate default.
  const persistedDirector =
    activeProject?.directorModel &&
    modelMatchesProvider(activeProject.directorModel, directorProvider)
      ? activeProject.directorModel
      : undefined;
  const directorModel = persistedDirector || directorFallbackModel;
  const fallbackEffort: EffortLevel = settings?.defaultEffort ?? DEFAULT_EFFORT;
  const directorFallbackEffort: EffortLevel =
    settings?.defaultDirectorEffort ?? fallbackEffort;
  const directorEffort: EffortLevel =
    activeProject?.directorEffort || directorFallbackEffort;
  // Spawn-form pre-fill stays on the agent defaults — we don't want a
  // 1M-context Opus Director to silently pre-select Opus for every new
  // worker the user spawns by hand. If the user pinned a project-level
  // Director model/effort, we honour that intent and pre-fill with it
  // (when it matches the provider; otherwise fall through).
  const spawnDefaultModel = persistedDirector || fallbackModel;
  const spawnDefaultEffort: EffortLevel =
    activeProject?.directorEffort || fallbackEffort;

  const { agents, selectedId, setSelectedId, expanded, toggle } = useAgents(
    activeProjectId,
  );
  const { messages, send, busy } = useDirector(activeProjectId);
  const selectedAgent = agents.find((a) => a.id === selectedId) ?? null;
  const [spawning, setSpawning] = useState(false);

  const totalTokens = agents.reduce((s, a) => s + a.tokens, 0);
  const totalCost = agents.reduce((s, a) => s + a.cost, 0);

  // Track agent counts per project for the tab badges. Hydrate from registry
  // on mount, then update from broadcast events for all projects (not just
  // the active one).
  useEffect(() => {
    let mounted = true;
    void (async () => {
      // L3: parallel fan-out. The serial await chain made tab-badge
      // hydration scale linearly with project count, which actually
      // showed up as a flicker on cold launch once a handful of
      // projects existed.
      const results = await Promise.all(
        projects.map((p) =>
          window.api.listAgents(p.id).then((list) => ({
            id: p.id,
            count: list.filter(
              (a) => a.status === 'running' || a.status === 'waiting',
            ).length,
          })),
        ),
      );
      if (!mounted) return;
      const counts: Record<string, number> = {};
      for (const r of results) counts[r.id] = r.count;
      setAgentCountByProject(counts);
    })();
    return () => {
      mounted = false;
    };
  }, [projects]);

  useEffect(() => {
    // H9: pull the IPC call out of the setState updater. React's
    // setState updater must be pure — StrictMode invokes it twice
    // in dev, which means a listAgents call lived in there was
    // firing twice per event in development.
    const refreshCount = (projectId: string): void => {
      void window.api.listAgents(projectId).then((list) => {
        const count = list.filter(
          (a) => a.status === 'running' || a.status === 'waiting',
        ).length;
        setAgentCountByProject((p) => ({ ...p, [projectId]: count }));
      });
    };
    const offAgent = window.api.onAgent(({ projectId }) => {
      refreshCount(projectId);
    });
    const offPatch = window.api.onPatch(({ projectId }) => {
      refreshCount(projectId);
    });
    const offRemove = window.api.onAgentRemove(({ projectId }) => {
      refreshCount(projectId);
    });
    return () => {
      offAgent();
      offPatch();
      offRemove();
    };
  }, []);

  const handledPlans = useRef<Set<string>>(new Set());
  const handledRedirects = useRef<Set<string>>(new Set());
  // M10: drop the dedupe sets on project switch. They tracked
  // message ids local to the previous project and grew unbounded
  // otherwise — every session-long active project accumulated one
  // entry per plan/redirect Director ever emitted.
  useEffect(() => {
    handledPlans.current = new Set();
    handledRedirects.current = new Set();
  }, [activeProjectId]);

  const spawnPlan = async (
    msg: DirectorMessage,
    rows?: PlanRow[],
  ) => {
    const effectiveRows = rows ?? msg.plan;
    if (!effectiveRows || msg.planAccepted || !activeProjectId) return;
    if (effectiveRows.length === 0) return;
    if (handledPlans.current.has(msg.id)) return;
    handledPlans.current.add(msg.id);
    let ws = workspace;
    if (!ws) {
      const { path } = await window.api.pickWorkspace();
      if (!path) {
        handledPlans.current.delete(msg.id);
        return;
      }
      ws = path;
    }
    // Find the user message that triggered this plan — scan backwards
    // from the plan message to the most recent 'user' entry. Its
    // attachments (typically pasted screenshots) flow through to every
    // agent the plan spawns, so the coder sees the same image the
    // Director did. Skipping intermediate system/handoff messages is
    // important: those don't carry user-supplied attachments.
    const planIdx = messages.findIndex((m) => m.id === msg.id);
    let originatingAttachments: string[] | undefined;
    if (planIdx >= 0) {
      for (let i = planIdx - 1; i >= 0; i--) {
        if (messages[i].who === 'user') {
          const refs = messages[i].attachments;
          if (refs && refs.length > 0) {
            originatingAttachments = refs.map((a) => a.path);
          }
          break;
        }
      }
    }
    try {
      await window.api.acceptPlan({
        projectId: activeProjectId,
        rows: effectiveRows,
        workspace: ws,
        ...(originatingAttachments
          ? { attachments: originatingAttachments }
          : {}),
      });
    } catch (e) {
      console.error('[orchestrator] spawn failed', e);
      handledPlans.current.delete(msg.id);
    }
  };

  const fireRedirect = async (
    messageId: string,
    agentName: string,
    instruction: string,
  ) => {
    if (!activeProjectId) return;
    if (handledRedirects.current.has(messageId)) return;
    handledRedirects.current.add(messageId);
    const target = agents.find((a) => a.name === agentName);
    if (!target) {
      console.warn(`[orchestrator] redirect target not found: @${agentName}`);
      handledRedirects.current.delete(messageId);
      return;
    }
    try {
      const res = await window.api.redirectAgent({
        agentId: target.id,
        body: instruction,
      });
      await window.api.ackDirectorRedirect({
        projectId: activeProjectId,
        messageId,
        agentName,
        ok: res.ok,
        error: res.error,
      });
    } catch (e) {
      console.error('[orchestrator] redirect fire failed', e);
      handledRedirects.current.delete(messageId);
    }
  };

  // Auto mode used to spawn plans the moment they landed. That meant a
  // 6-agent plan you didn't expect could already be three agents deep
  // before you finished reading it. Now plans always wait for an explicit
  // confirm (with optional inline edits) from the PlanCard. The auto-mode
  // bit still controls downstream orchestration — Director-issued
  // redirects fire automatically here, and once you click Spawn the
  // backend sequences the agents itself.
  // M10: when mode flips manual → auto, mark every redirect that
  // already existed as handled BEFORE the auto-fire effect runs.
  // Without this, flipping to auto burst-fires every pending
  // redirect at once with no user warning. The user opted into
  // auto for *future* turns; the manual-mode backlog should stay
  // manual.
  const prevModeRef = useRef(mode);
  useEffect(() => {
    if (prevModeRef.current !== 'auto' && mode === 'auto') {
      for (const msg of messages) {
        if (msg.redirect && !msg.redirectFired) {
          handledRedirects.current.add(msg.id);
        }
      }
    }
    prevModeRef.current = mode;
  }, [mode, messages]);

  useEffect(() => {
    if (mode !== 'auto' || !activeProjectId) return;
    void (async () => {
      for (const msg of messages) {
        if (msg.redirect && !msg.redirectFired) {
          await fireRedirect(
            msg.id,
            msg.redirect.agent,
            msg.redirect.instruction,
          );
        }
      }
    })();
  }, [messages, mode, activeProjectId, agents]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing =
        tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable;
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        setSpawning(true);
      } else if (e.key === '.' && !typing) {
        e.preventDefault();
        if (selectedId) void window.api.abortAgent(selectedId);
      } else if ((e.key === 'b' || e.key === 'B') && !typing) {
        e.preventDefault();
        setDrawerCollapsed(!drawerCollapsed);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, drawerCollapsed, setDrawerCollapsed]);

  const isHome = active === 'agents';

  return (
    <div className="app">
      <TopBar
        workspace={workspace}
        model={settings?.defaultModel ?? 'claude-sonnet-4-6'}
        totalTokens={totalTokens}
        totalCost={totalCost}
        viewMode={viewMode}
        onChangeWorkspace={async () => {
          if (!activeProjectId) return;
          const { path } = await window.api.pickWorkspace();
          if (path) await setProjectWorkspace(activeProjectId, path);
        }}
        onViewModeChange={setViewMode}
      />
      <ProjectTabs
        projects={projects}
        activeId={activeProjectId}
        agentCountByProject={agentCountByProject}
        onSelect={(id) => void setActiveProject(id)}
        onNewProject={() => setShowNewProject(true)}
        onDelete={(id) => setConfirmDeleteId(id)}
      />
      <div className="body">
        <LeftRail
          active={active}
          agentCount={agents.length}
          marketplaceUpdateCount={marketplace.pendingUpdates.length}
          onSelect={setActive}
        />

        {isHome && activeProjectId ? (
          <>
            <DirectorPane
              width={dirW}
              messages={messages}
              agents={agents}
              busy={busy}
              mode={mode}
              model={directorModel}
              effort={directorEffort}
              directorProvider={directorProvider}
              projectProvider={activeProvider}
              onModeChange={setMode}
              onModelChange={(m) => {
                if (activeProjectId) void setProjectDirectorModel(activeProjectId, m);
              }}
              onEffortChange={(e) => {
                if (activeProjectId) void setProjectDirectorEffort(activeProjectId, e);
              }}
              onDirectorProviderChange={(p) => {
                if (!activeProjectId) return;
                // null = clear override → fall back to project default.
                void setProjectDirectorProvider(
                  activeProjectId,
                  p === activeProvider ? null : p,
                );
              }}
              onSend={send}
              onSpawnPlan={spawnPlan}
              onWipe={async () => {
                if (activeProjectId)
                  await window.api.wipeDirector(activeProjectId);
              }}
              viewMode={viewMode}
              projectId={activeProjectId}
              onSlashAction={async (action: BuiltinAction) => {
                switch (action) {
                  case 'wipe-director':
                    if (activeProjectId)
                      await window.api.wipeDirector(activeProjectId);
                    break;
                  case 'open-usage':
                    await window.api.openClaudeUsage();
                    break;
                  case 'go-agents':
                    setActive('agents');
                    break;
                  case 'go-spend':
                    setActive('cost');
                    break;
                  case 'go-history':
                    setActive('history');
                    break;
                  case 'go-settings':
                    setActive('settings');
                    break;
                  case 'go-tools':
                    setActive('tools');
                    break;
                  case 'go-templates':
                    setActive('templates');
                    break;
                  case 'show-help':
                    // Handled locally inside the Composer (opens modal).
                    break;
                }
              }}
            />
            <ResizeHandle
              value={dirW}
              onChange={setDirW}
              min={300}
              max={640}
              edge="left"
            />
            <AgentsPane
              agents={agents}
              selectedId={selectedId}
              expanded={expanded}
              workspace={workspace}
              projectId={activeProjectId}
              defaultModel={spawnDefaultModel}
              defaultEffort={spawnDefaultEffort}
              spawning={spawning}
              viewMode={viewMode}
              provider={activeProject?.provider ?? 'claude'}
              setSpawning={setSpawning}
              onSelect={setSelectedId}
              onToggle={toggle}
            />
            {!drawerCollapsed && (
              <ResizeHandle
                value={drawerW}
                onChange={setDrawerW}
                min={340}
                max={680}
                edge="right"
              />
            )}
            <Drawer
              width={drawerW}
              agent={selectedAgent}
              collapsed={drawerCollapsed}
              provider={activeProject?.provider ?? 'claude'}
              onAbort={(id) => void window.api.abortAgent(id)}
              onToggleCollapsed={() => setDrawerCollapsed(!drawerCollapsed)}
            />
          </>
        ) : active === 'settings' ? (
          <SettingsScreen />
        ) : active === 'tools' ? (
          <ToolsScreen
            project={activeProject}
            onChange={async (roleTools) => {
              if (activeProjectId)
                await setProjectRoleTools(activeProjectId, roleTools);
            }}
            onMcpChange={async (config) => {
              if (!activeProjectId)
                return { ok: false, error: 'no active project' };
              return setMcpConfig(activeProjectId, config);
            }}
          />
        ) : active === 'marketplace' ? (
          <MarketplaceScreen
            projectId={activeProjectId}
            projectName={activeProject?.name ?? null}
            projectProvider={activeProject?.provider ?? null}
            directorProvider={activeProject ? directorProvider : null}
          />
        ) : active === 'cost' ? (
          <SpendScreen />
        ) : active === 'history' ? (
          <HistoryScreen
            projects={projects}
            onOpenAgent={async (projectId, agentId) => {
              if (projectId !== activeProjectId) {
                await setActiveProject(projectId);
              }
              setSelectedId(agentId);
              setActive('agents');
            }}
          />
        ) : (
          <PlaceholderScreen
            {...(active === 'agents'
              ? {
                  title: 'No project',
                  icon: 'agents' as const,
                  body: 'Create or select a project to get started.',
                }
              : PLACEHOLDERS[active])}
          />
        )}
      </div>
      <StatusBar agentCount={agents.length} />

      {marketplaceToast && (
        <button
          className="marketplace-toast"
          onClick={() => {
            setMarketplaceToast(null);
            setActive('marketplace');
          }}
          title="Click to open the Marketplace"
        >
          {marketplaceToast.count === 1
            ? '1 new bundle update available'
            : `${marketplaceToast.count} new bundle updates available`}{' '}
          · Marketplace
        </button>
      )}

      {showNewProject && (
        <NewProjectForm
          onCreate={async (name, ws, provider) => {
            const p = await createProject(name, ws, provider);
            await setActiveProject(p.id);
            setShowNewProject(false);
          }}
          onCancel={() => setShowNewProject(false)}
        />
      )}
      {confirmDeleteId &&
        (() => {
          const target = projects.find((p) => p.id === confirmDeleteId);
          if (!target) return null;
          return (
            <ConfirmDeleteProject
              project={target}
              onConfirm={async () => {
                // If deleting the active project, switch to another one first
                // so the UI doesn't briefly render an orphan state.
                if (confirmDeleteId === activeProjectId) {
                  const fallback = projects.find(
                    (p) => p.id !== confirmDeleteId,
                  );
                  if (fallback) await setActiveProject(fallback.id);
                }
                await removeProject(confirmDeleteId);
                setConfirmDeleteId(null);
              }}
              onCancel={() => setConfirmDeleteId(null)}
            />
          );
        })()}
      {cliStatus && !cliStatus[activeProvider] && (
        <CliMissingGate
          provider={activeProvider}
          onResolved={() =>
            setCliStatus((prev) =>
              prev ? { ...prev, [activeProvider]: true } : prev,
            )
          }
        />
      )}
    </div>
  );
}
