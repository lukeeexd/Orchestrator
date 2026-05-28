import type { Agent, LogLine } from '../../shared/types';
import { ROLE_TINT } from '../../shared/roles';
import { Icon } from './Icon';
import { LogLineRow } from './LogLineRow';

/**
 * P10: parse the agent's log for the most-recent line matching
 *   Tests: <passed> passed / <total> total
 * (case-insensitive, optional whitespace around `/`). Agents with
 * subtype 'playwright' are prompted to emit this line on completion,
 * but any QA agent that follows the convention gets the same chip.
 * Returns null when no matching line is found.
 *
 * Cheap enough to run on every render — the in-memory log is capped
 * at LOG_TAIL_CAP (2000) lines.
 */
const TESTS_KPI_RE = /Tests:\s*(\d+)\s*passed\s*\/\s*(\d+)\s*total/i;

function parseTestsKpi(log: LogLine[]): { passed: number; total: number } | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const line = log[i];
    if (typeof line.msg !== 'string') continue;
    const m = line.msg.match(TESTS_KPI_RE);
    if (m) {
      return { passed: parseInt(m[1], 10), total: parseInt(m[2], 10) };
    }
  }
  return null;
}

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
  const tests = parseTestsKpi(agent.log);
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
            {agent.subtype === 'playwright' && ' · Playwright'}
          </span>
        </span>
        <span className="agent-task">
          <span className="step">[{agent.step}]</span>
          {agent.task}
        </span>
        {tests && (
          <span
            className="metric"
            title={`Playwright result: ${tests.passed} of ${tests.total} tests passed`}
          >
            <span className="label">tests</span>
            <span
              className="val"
              style={{
                color:
                  tests.passed === tests.total
                    ? 'var(--accent)'
                    : 'var(--error)',
              }}
            >
              {tests.passed}/{tests.total}
            </span>
          </span>
        )}
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
