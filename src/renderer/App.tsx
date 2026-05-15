import { useState } from 'react';
import { useLocalStorageState } from './hooks/useLocalStorageState';
import { useAgents } from './hooks/useAgents';
import { TopBar } from './components/TopBar';
import { LeftRail, type RailScreen } from './components/LeftRail';
import { StatusBar } from './components/StatusBar';
import { DirectorPane } from './components/DirectorPane';
import { AgentsPane } from './components/AgentsPane';
import { Drawer } from './components/Drawer';
import { ResizeHandle } from './components/ResizeHandle';
import { PlaceholderScreen } from './components/PlaceholderScreen';

const PLACEHOLDERS: Record<
  Exclude<RailScreen, 'director' | 'agents'>,
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
  const { agents, selectedId, setSelectedId, expanded, toggle } = useAgents();

  const isHome = active === 'director' || active === 'agents';

  return (
    <div className="app">
      <TopBar />
      <div className="body">
        <LeftRail
          active={active}
          agentCount={agents.length}
          onSelect={setActive}
        />

        {isHome ? (
          <>
            <DirectorPane width={dirW} />
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
            <Drawer width={drawerW} />
          </>
        ) : (
          <PlaceholderScreen {...PLACEHOLDERS[active]} />
        )}
      </div>
      <StatusBar />
    </div>
  );
}
