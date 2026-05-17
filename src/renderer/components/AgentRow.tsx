import type { Agent } from '../../shared/types';
import { Icon } from './Icon';
import { LogLineRow } from './LogLineRow';

const ROLE_TINT: Record<Agent['role'], string> = {
  pm: '#4ade80',
  researcher: '#60a5fa',
  coder: '#c084fc',
  qa: '#fbbf24',
  devops: '#f97316',
  security: '#f87171',
};

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
    <div className={'agent' + (selected ? ' selected' : '')}>
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
            <LogLineRow key={i} line={l} />
          ))}
        </div>
      )}
    </div>
  );
}
