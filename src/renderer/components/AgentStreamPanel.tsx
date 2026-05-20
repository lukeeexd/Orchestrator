import { useEffect, useRef, useState } from 'react';
import type { Agent, LogLine, ToolCall } from '../../shared/types';
import { ROLE_TINT } from '../../shared/roles';
import { Icon } from './Icon';

/**
 * Terminal-style live log for a single agent. Replaces the row+drawer
 * structure of the compact view with a top-to-bottom scrolling panel
 * styled like Claude Code's CLI output: ●/⏺/⎿ glyphs prefix each line,
 * tool calls render with their args, results indent under their call.
 *
 * Auto-scrolls to the tail unless the user has scrolled up to read —
 * we lock at the current position while they're more than 80px away
 * from the bottom so streaming output doesn't yank them around.
 */
interface Props {
  agent: Agent;
  selected: boolean;
  onSelect: () => void;
  onAbort: () => void;
  onRemove: () => void;
}

const KIND_GLYPH: Record<LogLine['kind'], string> = {
  thought: '⏺',
  tool: '●',
  result: '⎿',
  warn: '⚠',
  error: '✗',
  note: ' ',
  handoff: '→',
};

export function AgentStreamPanel({
  agent,
  selected,
  onSelect,
  onAbort,
  onRemove,
}: Props) {
  const isRunning = agent.status === 'running' || agent.status === 'waiting';
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  // Local collapse state. Mirrors the chevron-toggle UX from the compact
  // view's AgentRow — clicking the chevron in the header hides the task
  // + log so a long-running agent's panel can be folded out of the way
  // without losing its place in the agents list.
  const [collapsed, setCollapsed] = useState(false);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setStickToBottom(
      el.scrollHeight - el.scrollTop - el.clientHeight < 80,
    );
  };

  useEffect(() => {
    if (!stickToBottom) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [agent.log.length, stickToBottom]);

  return (
    <div
      className={'agent-stream' + (selected ? ' selected' : '')}
      onClick={onSelect}
    >
      <div className="agent-stream-head">
        <button
          className="icon-btn"
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed((c) => !c);
          }}
          title={collapsed ? 'Expand' : 'Collapse'}
          style={{ width: 20, height: 20 }}
        >
          <Icon name={collapsed ? 'chevron' : 'chevron-down'} size={11} />
        </button>
        <span className={'dotled ' + agent.status}>
          <i />
        </span>
        <span className="name">{agent.name}</span>
        <span className="role" style={{ color: ROLE_TINT[agent.role] }}>
          {agent.roleLabel}
        </span>
        <span className="dim status-label">{agent.statusLabel}</span>
        <span className="spacer" />
        <span className="mini-kpi">
          <span className="dim">tok</span> {(agent.tokens / 1000).toFixed(1)}k
        </span>
        <span className="mini-kpi">
          <span className="dim">$</span> {agent.cost.toFixed(2)}
        </span>
        <span className="mini-kpi">
          <span className="dim">t</span> {agent.elapsed}
        </span>
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
      </div>
      {!collapsed && (
        <>
          <div className="agent-stream-task" title={agent.task}>
            <span className="dim">›</span> {agent.task}
          </div>
          <div
            className="agent-stream-log"
            ref={scrollRef}
            onScroll={onScroll}
          >
            {agent.log.length === 0 ? (
              <div className="dim agent-stream-empty">
                {isRunning ? 'Awaiting first response…' : 'No log entries.'}
              </div>
            ) : (
              // M11: composite key so a memoised StreamLine survives
              // re-renders driven by sibling log appends.
              agent.log.map((line, i) => (
                <StreamLine key={`${line.ts}-${line.kind}-${i}`} line={line} />
              ))
            )}
            {isRunning && (
              <span className="log-cursor" aria-hidden="true">
                ▍
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function StreamLine({ line }: { line: LogLine }) {
  const glyph = KIND_GLYPH[line.kind] ?? ' ';
  return (
    <div className={'stream-line stream-line-' + line.kind}>
      <span className="glyph">{glyph}</span>
      <span className="ts dim">{line.ts}</span>
      <span className="msg">
        {typeof line.msg === 'string' ? line.msg : <ToolMsg msg={line.msg} />}
      </span>
    </div>
  );
}

function ToolMsg({ msg }: { msg: ToolCall }) {
  return (
    <span>
      <span className="fn">{msg.fn}</span>
      <span className="dim">(</span>
      {msg.args.map((a, i) => (
        <span key={i}>
          {i > 0 && <span className="dim">, </span>}
          <span className="arg">{a.k}</span>
          <span className="dim">: </span>
          <span className="str">{a.v}</span>
        </span>
      ))}
      <span className="dim">)</span>
    </span>
  );
}
