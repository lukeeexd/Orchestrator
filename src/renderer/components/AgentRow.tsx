import type { Agent } from '../../shared/types';
import { ROLE_TINT } from '../../shared/roles';
import { Icon } from './Icon';
import { LogLineRow } from './LogLineRow';

interface Props {
  agent: Agent;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onAbort: () => void;
  onRemove: () => void;
}

export function AgentRow({
  agent,
  selected,
  expanded,
  onSelect,
  onToggle,
  onAbort,
  onRemove,
}: Props) {
  const isRunning = agent.status === 'running' || agent.status === 'waiting';
  return (
    // H11: each row is a tabbable listitem so the AgentsPane's
    // arrow-key handler can move focus through the list and Enter
    // toggles expansion.
    <div
      className={'agent' + (selected ? ' selected' : '')}
      role="listitem"
      tabIndex={selected ? 0 : -1}
      aria-selected={selected}
      aria-label={`${agent.roleLabel} ${agent.name} — ${agent.statusLabel}`}
    >
      <div className="agent-head" onClick={onSelect}>
        <button
          className="chev"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          style={{
            background: 'transparent',
            border: 0,
            color: 'var(--muted)',
            cursor: 'default',
            padding: 0,
          }}
        >
          <Icon name={expanded ? 'chevron-down' : 'chevron'} size={11} />
        </button>
        <span className={'dotled ' + agent.status}>
          <i />
        </span>
        <span className="agent-id">
          <span className="name">{agent.name}</span>
          <span className="role" style={{ color: ROLE_TINT[agent.role] }}>
            {agent.roleLabel}
          </span>
        </span>
        <span className="agent-task">
          <span className="step">[{agent.step}]</span>
          {agent.task}
        </span>
        <span className="metric">
          <span className="label">tokens</span>
          <span className="val">{(agent.tokens / 1000).toFixed(1)}k</span>
        </span>
        <span className="metric">
          <span className="label">cost</span>
          <span className="val">${agent.cost.toFixed(2)}</span>
        </span>
        <span className="agent-actions">
          {isRunning ? (
            <button
              className="icon-btn"
              title="Abort"
              onClick={(e) => {
                e.stopPropagation();
                onAbort();
              }}
            >
              <Icon name="stop" size={11} />
            </button>
          ) : (
            <button
              className="icon-btn"
              title="Remove from list"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
            >
              <Icon name="x" size={11} />
            </button>
          )}
        </span>
      </div>

      {expanded && (
        <div className="agent-log">
          <div className="log-divider" />
          {agent.log.map((l, i) => (
            // M11: composite key — ts+kind+index stays stable when
            // appending (the common case) AND remains unique enough
            // for the rare paginated prepend scroll. Bare index keyed
            // off paginated content broke the memo on every batch.
            <LogLineRow key={`${l.ts}-${l.kind}-${i}`} line={l} />
          ))}
        </div>
      )}
    </div>
  );
}
