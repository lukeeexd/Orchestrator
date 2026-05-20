import { memo } from 'react';
import type { LogLine, ToolCall } from '../../shared/types';

interface Props {
  line: LogLine;
}

/**
 * H8: memoised so the long-running chatty-agent case doesn't
 * re-render every prior row on each streamed line. LogLine
 * objects are immutable (the runner creates a new instance per
 * line and never mutates them in place), so reference equality
 * is a correct memo check here.
 */
function LogLineRowInner({ line }: Props) {
  return (
    <div className={'log-line ' + line.kind}>
      <span className="ts">{line.ts}</span>
      <span className="kind">{line.kind}</span>
      <span className="msg">
        <LogMsg msg={line.msg} />
      </span>
    </div>
  );
}

export const LogLineRow = memo(LogLineRowInner);

function LogMsg({ msg }: { msg: string | ToolCall }) {
  if (typeof msg === 'string') return <span>{msg}</span>;
  return (
    <span>
      <span className="fn">{msg.fn}</span>
      <span className="dim">(</span>
      {msg.args.map((a, i) => (
        <span key={i}>
          {i > 0 && <span className="dim">, </span>}
          <span className="arg">{a.k}</span>
          <span className="dim">=</span>
          <span className="str">"{a.v}"</span>
        </span>
      ))}
      <span className="dim">)</span>
    </span>
  );
}
