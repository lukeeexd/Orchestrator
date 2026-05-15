// Reusable icons + tiny presentational helpers.

const Icon = ({ name, size = 14, color = 'currentColor', stroke = 1.6 }) => {
  const s = size;
  const c = color;
  const sw = stroke;
  const props = {
    width: s, height: s, viewBox: '0 0 16 16',
    fill: 'none', stroke: c, strokeWidth: sw,
    strokeLinecap: 'round', strokeLinejoin: 'round',
  };
  switch (name) {
    case 'director': return (
      <svg {...props}><path d="M8 1.5l5.5 3.2v6.6L8 14.5 2.5 11.3V4.7L8 1.5z"/><path d="M8 5.5v5M5.5 7v2M10.5 7v2"/></svg>
    );
    case 'agents': return (
      <svg {...props}><circle cx="5" cy="5" r="2"/><circle cx="11" cy="5" r="2"/><circle cx="8" cy="11" r="2"/><path d="M5 7l3 2M11 7l-3 2"/></svg>
    );
    case 'templates': return (
      <svg {...props}><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>
    );
    case 'history': return (
      <svg {...props}><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>
    );
    case 'tools': return (
      <svg {...props}><path d="M10.5 2L13.5 5L10 8.5L7 5.5L10.5 2z"/><path d="M7 5.5l-5 5v3h3l5-5"/></svg>
    );
    case 'cost': return (
      <svg {...props}><path d="M8 2v12M11 5c0-1.5-1.3-2-3-2s-3 .5-3 2 1.5 2 3 2 3 .5 3 2-1.3 2-3 2-3-.5-3-2"/></svg>
    );
    case 'settings': return (
      <svg {...props}><circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M1.5 8h2M12.5 8h2M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4"/></svg>
    );
    case 'play': return (
      <svg {...props}><path d="M4 2.5v11l9-5.5-9-5.5z" fill={c}/></svg>
    );
    case 'pause': return (
      <svg {...props}><rect x="4" y="3" width="3" height="10"/><rect x="9" y="3" width="3" height="10"/></svg>
    );
    case 'stop': return (
      <svg {...props}><rect x="3.5" y="3.5" width="9" height="9" rx="1"/></svg>
    );
    case 'fork': return (
      <svg {...props}><circle cx="4" cy="3.5" r="1.5"/><circle cx="12" cy="3.5" r="1.5"/><circle cx="8" cy="12.5" r="1.5"/><path d="M4 5v3a2 2 0 002 2h4a2 2 0 002-2V5"/><path d="M8 10v1"/></svg>
    );
    case 'check': return (
      <svg {...props}><path d="M3 8.5L6.5 12L13 4.5"/></svg>
    );
    case 'x': return (
      <svg {...props}><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>
    );
    case 'redirect': return (
      <svg {...props}><path d="M2 5h8a4 4 0 014 4v3M10 2l-3 3 3 3"/></svg>
    );
    case 'plus': return (
      <svg {...props}><path d="M8 2v12M2 8h12"/></svg>
    );
    case 'cmd': return (
      <svg {...props}><path d="M5 5h6v6H5z"/><path d="M5 5V3.5a1.5 1.5 0 10-1.5 1.5H5zM11 5V3.5a1.5 1.5 0 111.5 1.5H11zM5 11v1.5a1.5 1.5 0 11-1.5-1.5H5zM11 11v1.5a1.5 1.5 0 101.5-1.5H11z"/></svg>
    );
    case 'send': return (
      <svg {...props}><path d="M2 8L14 2L10 14L8 9L2 8z" fill={c} stroke="none"/></svg>
    );
    case 'attach': return (
      <svg {...props}><path d="M10 4L5 9a2 2 0 102.8 2.8l5-5a3.5 3.5 0 00-5-5L3 6.5"/></svg>
    );
    case 'chevron': return (
      <svg {...props}><path d="M6 4l4 4-4 4"/></svg>
    );
    case 'chevron-down': return (
      <svg {...props}><path d="M4 6l4 4 4-4"/></svg>
    );
    case 'pin': return (
      <svg {...props}><path d="M8 1.5l2 3.5h2l-3 3 1 5L8 11l-2 2 1-5-3-3h2l2-3.5z" fill={c} stroke="none"/></svg>
    );
    case 'file': return (
      <svg {...props}><path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/></svg>
    );
    case 'logs': return (
      <svg {...props}><path d="M3 4h10M3 8h10M3 12h7"/></svg>
    );
    case 'memory': return (
      <svg {...props}><rect x="2.5" y="3.5" width="11" height="9" rx="1"/><path d="M5 6h6M5 8h6M5 10h4"/></svg>
    );
    case 'context': return (
      <svg {...props}><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/></svg>
    );
    case 'expand': return (
      <svg {...props}><path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3"/></svg>
    );
    case 'more': return (
      <svg {...props}><circle cx="3.5" cy="8" r="1" fill={c}/><circle cx="8" cy="8" r="1" fill={c}/><circle cx="12.5" cy="8" r="1" fill={c}/></svg>
    );
    case 'branch': return (
      <svg {...props}><path d="M4 2v12M4 6c0 2 2 2 4 2s4 0 4 4M12 4v0M12 4l-1.5-1.5M12 4l1.5-1.5"/></svg>
    );
    default: return null;
  }
};

// Color tag for a role.
const ROLE_TINT = {
  pm: '#4ade80',
  researcher: '#60a5fa',
  coder: '#c084fc',
  qa: '#fbbf24',
  devops: '#f97316',
};

// Render the formatted "tool call" line, e.g. read_file(path="…")
function ToolCall({ msg }) {
  if (typeof msg === 'string') return <span>{msg}</span>;
  return (
    <span>
      <span className="fn">{msg.fn}</span>
      <span className="dim">(</span>
      {msg.args.map((a, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="dim">, </span>}
          <span className="arg">{a.k}</span>
          <span className="dim">=</span>
          <span className="str">"{a.v}"</span>
        </React.Fragment>
      ))}
      <span className="dim">)</span>
    </span>
  );
}

Object.assign(window, { Icon, ROLE_TINT, ToolCall });
