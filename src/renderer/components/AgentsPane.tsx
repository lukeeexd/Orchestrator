import type { Agent, EffortLevel } from '../../shared/types';
import { Icon } from './Icon';
import { AgentRow } from './AgentRow';
import { AgentStreamPanel } from './AgentStreamPanel';
import { SpawnAgentForm } from './SpawnAgentForm';
import type { ViewMode } from './TopBar';

interface Props {
  agents: Agent[];
  selectedId: string | null;
  expanded: Record<string, boolean>;
  workspace: string;
  projectId: string;
  defaultModel: string;
  defaultEffort: EffortLevel;
  spawning: boolean;
  viewMode: ViewMode;
  setSpawning: (next: boolean) => void;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}

export function AgentsPane({
  agents,
  selectedId,
  expanded,
  workspace,
  projectId,
  defaultModel,
  defaultEffort,
  spawning,
  viewMode,
  setSpawning,
  onSelect,
  onToggle,
}: Props) {
  const activeCount = agents.filter(
    (a) => a.status === 'running' || a.status === 'waiting',
  ).length;

  return (
    <div className="pane agents-pane">
      <div className="pane-head">
        <span className="title">
          Agents{' '}
          <b>
            · {activeCount} active{agents.length > activeCount ? ` / ${agents.length} total` : ''}
          </b>
        </span>
        <span className="spacer" />
        <button className="tb-btn primary" onClick={() => setSpawning(true)}>
          <Icon name="plus" size={11} /> New agent
          <span className="kbd">⌘N</span>
        </button>
      </div>

      {agents.length === 0 ? (
        <EmptyAgents onNew={() => setSpawning(true)} />
      ) : viewMode === 'stream' ? (
        <div className="agents-stream">
          {agents.map((a) => (
            <AgentStreamPanel
              key={a.id}
              agent={a}
              selected={selectedId === a.id}
              onSelect={() => onSelect(a.id)}
              onAbort={() => void window.api.abortAgent(a.id)}
              onRemove={() => void window.api.removeAgent(a.id)}
            />
          ))}
        </div>
      ) : (
        <div className="agents-list">
          {agents.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              selected={selectedId === a.id}
              expanded={expanded[a.id] ?? false}
              onSelect={() => onSelect(a.id)}
              onToggle={() => onToggle(a.id)}
              onAbort={() => void window.api.abortAgent(a.id)}
              onRemove={() => void window.api.removeAgent(a.id)}
            />
          ))}
        </div>
      )}

      {spawning && (
        <SpawnAgentForm
          projectId={projectId}
          defaultWorkspace={workspace}
          defaultModel={defaultModel}
          defaultEffort={defaultEffort}
          onCancel={() => setSpawning(false)}
          onSpawned={() => setSpawning(false)}
        />
      )}
    </div>
  );
}

function EmptyAgents({ onNew }: { onNew: () => void }) {
  return (
    <div className="empty">
      <div className="empty-glyph">
        <Icon name="agents" size={28} color="var(--accent)" stroke={1.2} />
      </div>
      <div className="empty-title">No agents running</div>
      <div className="empty-body">
        Agents are spawned by the Director when you send it a task, or manually
        from here. Each agent gets its own context, tools, memory, and live
        log.
      </div>
      <div className="empty-actions">
        <button className="tb-btn primary" onClick={onNew}>
          <Icon name="plus" size={11} /> New agent
          <span className="kbd">⌘N</span>
        </button>
      </div>
    </div>
  );
}
