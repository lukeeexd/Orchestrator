import { useEffect, useRef, useState } from 'react';
import type {
  DirectorMessage,
  DirectorMode,
  EffortLevel,
  Project,
} from '../shared/types';
import { DEFAULT_EFFORT } from '../shared/efforts';
import { useLocalStorageState } from './hooks/useLocalStorageState';
import { useAgents } from './hooks/useAgents';
import { useDirector } from './hooks/useDirector';
import { useSettings } from './hooks/useSettings';
import { useProjects } from './hooks/useProjects';
import { TopBar } from './components/TopBar';
import { LeftRail, type RailScreen } from './components/LeftRail';
import { StatusBar } from './components/StatusBar';
import { DirectorPane } from './components/DirectorPane';
import { AgentsPane } from './components/AgentsPane';
import { Drawer } from './components/Drawer';
import { ResizeHandle } from './components/ResizeHandle';
import { PlaceholderScreen } from './components/PlaceholderScreen';
import { SettingsScreen } from './components/SettingsScreen';
import {
  ProjectTabs,
  NewProjectForm,
  ConfirmDeleteProject,
} from './components/ProjectTabs';

const PLACEHOLDERS: Record<
  Exclude<RailScreen, 'agents' | 'settings'>,
  { title: string; icon: Parameters<typeof PlaceholderScreen>[0]['icon']; body: string }
> = {
  templates: {
    title: 'Templates',
    icon: 'templates',
    body: 'Saved agent fleets. Pick a template, the Director spawns the matching agents with their system prompts and tool allow-lists already wired.',
  },
  tools: {
    title: 'Tools',
    icon: 'tools',
    body: 'Registry of tools available to agents, with per-role allow-lists. Until this lands, each role uses a hardcoded default tool set.',
  },
  cost: {
    title: 'Spend',
    icon: 'cost',
    body: 'Historical cost analytics — per session, per agent, per tool. Track where your tokens go and which agents are worth the spend.',
  },
  history: {
    title: 'Runs',
    icon: 'history',
    body: 'Past sessions, searchable. Replay an old run, fork from any point, or audit what an agent did.',
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
  const [showNewProject, setShowNewProject] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [agentCountByProject, setAgentCountByProject] = useState<
    Record<string, number>
  >({});

  const { settings } = useSettings();
  const {
    projects,
    activeId: activeProjectId,
    setActive: setActiveProject,
    create: createProject,
    setWorkspace: setProjectWorkspace,
    setDirectorModel: setProjectDirectorModel,
    setDirectorEffort: setProjectDirectorEffort,
    remove: removeProject,
  } = useProjects();
  const activeProject: Project | null =
    projects.find((p) => p.id === activeProjectId) ?? null;
  const workspace = activeProject?.workspace ?? '';
  const fallbackModel = settings?.defaultModel ?? 'claude-sonnet-4-6';
  const directorModel = activeProject?.directorModel || fallbackModel;
  const fallbackEffort: EffortLevel = settings?.defaultEffort ?? DEFAULT_EFFORT;
  const directorEffort: EffortLevel =
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
      const counts: Record<string, number> = {};
      for (const p of projects) {
        const list = await window.api.listAgents(p.id);
        if (!mounted) return;
        counts[p.id] = list.filter(
          (a) => a.status === 'running' || a.status === 'waiting',
        ).length;
      }
      if (mounted) setAgentCountByProject(counts);
    })();
    return () => {
      mounted = false;
    };
  }, [projects]);

  useEffect(() => {
    const offAgent = window.api.onAgent(({ projectId, agent }) => {
      setAgentCountByProject((prev) => {
        // Recompute from scratch by polling the registry would be expensive;
        // approximate by bumping/decrementing based on the running flag.
        const before = prev[projectId] ?? 0;
        const wasActive = before > 0 ? before : 0;
        // We don't know the previous status here, so just refresh from API.
        void window.api.listAgents(projectId).then((list) => {
          const count = list.filter(
            (a) => a.status === 'running' || a.status === 'waiting',
          ).length;
          setAgentCountByProject((p) => ({ ...p, [projectId]: count }));
        });
        return { ...prev, [projectId]: wasActive };
      });
    });
    const offPatch = window.api.onPatch(({ projectId }) => {
      void window.api.listAgents(projectId).then((list) => {
        const count = list.filter(
          (a) => a.status === 'running' || a.status === 'waiting',
        ).length;
        setAgentCountByProject((p) => ({ ...p, [projectId]: count }));
      });
    });
    const offRemove = window.api.onAgentRemove(({ projectId }) => {
      void window.api.listAgents(projectId).then((list) => {
        const count = list.filter(
          (a) => a.status === 'running' || a.status === 'waiting',
        ).length;
        setAgentCountByProject((p) => ({ ...p, [projectId]: count }));
      });
    });
    return () => {
      offAgent();
      offPatch();
      offRemove();
    };
  }, []);

  const handledPlans = useRef<Set<string>>(new Set());
  const handledRedirects = useRef<Set<string>>(new Set());

  const spawnPlan = async (msg: DirectorMessage) => {
    if (!msg.plan || msg.planAccepted || !activeProjectId) return;
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
    try {
      await window.api.acceptPlan({
        projectId: activeProjectId,
        rows: msg.plan,
        workspace: ws,
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

  useEffect(() => {
    if (mode !== 'auto' || !activeProjectId) return;
    void (async () => {
      for (const msg of messages) {
        if (msg.plan && !msg.planAccepted) await spawnPlan(msg);
        if (msg.redirect && !msg.redirectFired) {
          await fireRedirect(
            msg.id,
            msg.redirect.agent,
            msg.redirect.instruction,
          );
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId]);

  const isHome = active === 'agents';

  return (
    <div className="app">
      <TopBar
        workspace={workspace}
        model={settings?.defaultModel ?? 'claude-sonnet-4-6'}
        totalTokens={totalTokens}
        totalCost={totalCost}
        onChangeWorkspace={async () => {
          if (!activeProjectId) return;
          const { path } = await window.api.pickWorkspace();
          if (path) await setProjectWorkspace(activeProjectId, path);
        }}
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
              onModeChange={setMode}
              onModelChange={(m) => {
                if (activeProjectId) void setProjectDirectorModel(activeProjectId, m);
              }}
              onEffortChange={(e) => {
                if (activeProjectId) void setProjectDirectorEffort(activeProjectId, e);
              }}
              onSend={send}
              onSpawnPlan={spawnPlan}
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
              defaultModel={directorModel}
              defaultEffort={directorEffort}
              spawning={spawning}
              setSpawning={setSpawning}
              onSelect={setSelectedId}
              onToggle={toggle}
            />
            <ResizeHandle
              value={drawerW}
              onChange={setDrawerW}
              min={340}
              max={680}
              edge="right"
            />
            <Drawer
              width={drawerW}
              agent={selectedAgent}
              onAbort={(id) => void window.api.abortAgent(id)}
            />
          </>
        ) : active === 'settings' ? (
          <SettingsScreen />
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

      {showNewProject && (
        <NewProjectForm
          onCreate={async (name, ws) => {
            const p = await createProject(name, ws);
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
    </div>
  );
}
