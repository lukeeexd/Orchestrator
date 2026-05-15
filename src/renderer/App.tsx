import { useEffect, useRef, useState } from 'react';
import type { DirectorMessage, DirectorMode } from '../shared/types';
import { useLocalStorageState } from './hooks/useLocalStorageState';
import { useAgents } from './hooks/useAgents';
import { useDirector } from './hooks/useDirector';
import { useSettings } from './hooks/useSettings';
import { TopBar } from './components/TopBar';
import { LeftRail, type RailScreen } from './components/LeftRail';
import { StatusBar } from './components/StatusBar';
import { DirectorPane } from './components/DirectorPane';
import { AgentsPane } from './components/AgentsPane';
import { Drawer } from './components/Drawer';
import { ResizeHandle } from './components/ResizeHandle';
import { PlaceholderScreen } from './components/PlaceholderScreen';

const PLACEHOLDERS: Record<
  Exclude<RailScreen, 'agents'>,
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
  settings: {
    title: 'Settings',
    icon: 'settings',
    body: 'API key, model preferences, theme, keyboard shortcuts. For v1 the API key lives in a JSON file under the user-data directory.',
  },
};

export function App() {
  const [active, setActive] = useState<RailScreen>('agents');
  const [dirW, setDirW] = useLocalStorageState<number>(
    'orchestrator.dirW',
    400,
  );
  const [drawerW, setDrawerW] = useLocalStorageState<number>(
    'orchestrator.drawerW',
    460,
  );
  const [workspace, setWorkspace] = useLocalStorageState<string>(
    'orchestrator.workspace',
    '',
  );
  const [mode, setMode] = useLocalStorageState<DirectorMode>(
    'orchestrator.directorMode',
    'auto',
  );
  const { agents, selectedId, setSelectedId, expanded, toggle } = useAgents();
  const { messages, send, busy } = useDirector();
  const settings = useSettings();
  const selectedAgent = agents.find((a) => a.id === selectedId) ?? null;
  const [spawning, setSpawning] = useState(false);

  const totalTokens = agents.reduce((s, a) => s + a.tokens, 0);
  const totalCost = agents.reduce((s, a) => s + a.cost, 0);

  // Global keyboard shortcuts. Skip when the user is typing in an input.
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

  const handledPlans = useRef<Set<string>>(new Set());

  const spawnPlan = async (msg: DirectorMessage) => {
    if (!msg.plan || msg.planAccepted) return;
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
      setWorkspace(ws);
    }
    try {
      await window.api.acceptPlan({ rows: msg.plan, workspace: ws });
    } catch (e) {
      console.error('[orchestrator] spawn failed', e);
      handledPlans.current.delete(msg.id);
    }
  };

  // Auto-spawn plans in 'auto' mode. In 'manual' mode the user clicks
  // "Spawn this" on the plan card if they want it.
  useEffect(() => {
    if (mode !== 'auto') return;
    void (async () => {
      for (const msg of messages) {
        if (msg.plan && !msg.planAccepted) {
          await spawnPlan(msg);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, mode, workspace]);

  const changeWorkspace = async () => {
    const { path } = await window.api.pickWorkspace();
    if (path) setWorkspace(path);
  };

  const isHome = active === 'agents';

  return (
    <div className="app">
      <TopBar
        workspace={workspace}
        model={settings?.defaultModel ?? 'claude-sonnet-4-6'}
        totalTokens={totalTokens}
        totalCost={totalCost}
        onChangeWorkspace={changeWorkspace}
      />
      <div className="body">
        <LeftRail
          active={active}
          agentCount={agents.length}
          onSelect={setActive}
        />

        {isHome ? (
          <>
            <DirectorPane
              width={dirW}
              messages={messages}
              agents={agents}
              busy={busy}
              mode={mode}
              onModeChange={setMode}
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
        ) : (
          <PlaceholderScreen {...PLACEHOLDERS[active]} />
        )}
      </div>
      <StatusBar agentCount={agents.length} />
    </div>
  );
}
