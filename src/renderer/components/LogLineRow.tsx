import type { LogLine, ToolCall } from '../../shared/types';

interface Props {
  line: LogLine;
}

export function LogLineRow({ line }: Props) {
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
