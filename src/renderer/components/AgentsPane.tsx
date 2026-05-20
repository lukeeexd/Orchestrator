import { useState } from 'react';
import type { Agent, EffortLevel, Provider } from '../../shared/types';
import { Icon } from './Icon';
import { AgentRow } from './AgentRow';
import { AgentStreamPanel } from './AgentStreamPanel';
import { SpawnAgentForm } from './SpawnAgentForm';
import { FocusedFixDialog } from './FocusedFixDialog';
import { OnboardingBanner } from './OnboardingBanner';
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
  provider: Provider;
  /**
   * When set, renders the P2 onboarding banner at the top of the pane.
   * Computed in the parent (App.tsx) so the trigger logic lives next
   * to the rest of the project / workspace state.
   */
  onboardingBanner?: {
    busy: boolean;
    onRun: () => void;
    onSkip: () => void;
  };
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
  provider,
  onboardingBanner,
  setSpawning,
  onSelect,
  onToggle,
}: Props) {
  const activeCount = agents.filter(
    (a) => a.status === 'running' || a.status === 'waiting',
  ).length;

  // Local "focused fix" dialog state. The quick-spawn flow lives next
  // to the regular spawn flow but is a different shape — kept local
  // here so the parent doesn't need to thread a second spawning bit.
  const [focusedFixOpen, setFocusedFixOpen] = useState(false);

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
        <button
          className="tb-btn"
          onClick={() => setFocusedFixOpen(true)}
          title="Skip the Director — spawn a single coder pinned to one file"
        >
          <Icon name="file" size={11} /> Focused fix
        </button>
        <button className="tb-btn primary" onClick={() => setSpawning(true)}>
          <Icon name="plus" size={11} /> New agent
          <span className="kbd">⌘N</span>
        </button>
      </div>

      {onboardingBanner && (
        <OnboardingBanner
          busy={onboardingBanner.busy}
          onRun={onboardingBanner.onRun}
          onSkip={onboardingBanner.onSkip}
        />
      )}

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
        // H11: role="list" + per-row listitem + arrow-key navigation
        // turns the agents pane into a proper a11y list. The
        // keyboard handler advances selection up/down within the
        // list; Enter expands the focused row.
        <div
          className="agents-list"
          role="list"
          onKeyDown={(e) => {
            if (agents.length === 0) return;
            const idx = agents.findIndex((a) => a.id === selectedId);
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              const next = agents[Math.min(idx + 1, agents.length - 1)];
              if (next) onSelect(next.id);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              const prev = agents[Math.max(idx - 1, 0)];
              if (prev) onSelect(prev.id);
            } else if (e.key === 'Enter' && idx >= 0) {
              e.preventDefault();
              onToggle(agents[idx].id);
            }
          }}
        >
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
          provider={provider}
          onCancel={() => setSpawning(false)}
          onSpawned={() => setSpawning(false)}
        />
      )}
      {focusedFixOpen && (
        <FocusedFixDialog
          projectId={projectId}
          workspace={workspace}
          defaultModel={defaultModel}
          defaultEffort={defaultEffort}
          provider={provider}
          onCancel={() => setFocusedFixOpen(false)}
          onSpawned={() => setFocusedFixOpen(false)}
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
