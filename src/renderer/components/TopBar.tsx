import { Icon } from './Icon';

export function TopBar() {
  return (
    <div className="topbar">
      <div className="tb-crumb">
        <span className="proj">orchestrator</span>
        <span className="slash">/</span>
        <span style={{ color: 'var(--muted)' }}>no active session</span>
      </div>

      <div className="tb-spacer" />

      <div className="tb-pill" title="Total tokens this session">
        <span className="label">tokens</span>
        <span className="val">—</span>
      </div>
      <div className="tb-pill" title="Cost / budget">
        <span className="label">$</span>
        <span className="val">0.00</span>
        <span style={{ color: 'var(--muted-2)' }}>/ 5.00</span>
      </div>
      <div className="tb-pill">
        <span className="dot" />
        <span className="val">select model</span>
        <Icon name="chevron-down" size={11} color="var(--muted)" />
      </div>

      <div style={{ width: 1, height: 18, background: 'var(--border-2)' }} />

      <button className="tb-btn" disabled style={{ opacity: 0.5 }}>
        <Icon name="pause" size={11} /> Pause all
      </button>
      <button className="tb-btn primary">
        <Icon name="play" size={11} /> Start
        <span className="kbd">⌘↵</span>
      </button>
    </div>
  );
}
