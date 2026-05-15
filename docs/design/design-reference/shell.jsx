// Window chrome: TopBar + LeftRail + StatusBar.

function TopBar() {
  const s = window.SESSION;
  const pct = s ? Math.round((s.totalCost / s.budget) * 100) : 0;
  return (
    <div className="topbar">
      <div className="traffic"><i/><i/><i/></div>

      <div className="tb-crumb">
        <span className="proj">orchestrator</span>
        {s ? (
          <>
            <span className="slash">/</span>
            <span className="session">{s.title}</span>
            <span className="slash">·</span>
            <span style={{ color: 'var(--muted)' }}>{s.id}</span>
          </>
        ) : (
          <>
            <span className="slash">/</span>
            <span style={{ color: 'var(--muted)' }}>no active session</span>
          </>
        )}
      </div>

      <div className="tb-spacer" />

      <div className="tb-pill" title="Total tokens this session">
        <span className="label">tokens</span>
        <span className="val">{s ? s.totalTokens.toLocaleString() : '—'}</span>
      </div>
      <div className="tb-pill" title="Cost / budget">
        <span className="label">$</span>
        <span className="val">{s ? s.totalCost.toFixed(2) : '0.00'}</span>
        <span style={{ color: 'var(--muted-2)' }}>/ {(s ? s.budget : 5.00).toFixed(2)}</span>
        {s && (
          <span style={{
            marginLeft: 6, padding: '0 5px', borderRadius: 3,
            background: 'rgba(74,222,128,0.12)', color: 'var(--accent)',
            fontSize: 10,
          }}>{pct}%</span>
        )}
      </div>
      <div className="tb-pill">
        <span className="dot" />
        <span className="val">{s ? s.director.model : 'select model'}</span>
        <Icon name="chevron-down" size={11} color="var(--muted)" />
      </div>

      <div style={{ width: 1, height: 18, background: 'var(--border-2)' }} />

      <button className="tb-btn" disabled={!s} style={{ opacity: s ? 1 : 0.5 }}>
        <Icon name="pause" size={11} /> Pause all
      </button>
      <button className="tb-btn primary">
        <Icon name="play" size={11} /> {s ? 'Resume' : 'Start'}
        <span className="kbd">⌘↵</span>
      </button>
    </div>
  );
}

function LeftRail({ active = 'agents' }) {
  const items = [
    { id: 'director',  icon: 'director',  label: 'Director' },
    { id: 'agents',    icon: 'agents',    label: 'Agents',
      badge: window.AGENTS.length ? String(window.AGENTS.length) : null },
    { id: 'templates', icon: 'templates', label: 'Templates' },
    { id: 'tools',     icon: 'tools',     label: 'Tools' },
    { id: 'cost',      icon: 'cost',      label: 'Spend' },
    { id: 'history',   icon: 'history',   label: 'Runs' },
  ];
  return (
    <div className="rail">
      {items.map((it) => (
        <div key={it.id} className={'rail-item' + (active === it.id ? ' active' : '')} title={it.label}>
          <Icon name={it.icon} size={16} />
          {it.badge && <span className="badge">{it.badge}</span>}
        </div>
      ))}
      <div className="rail-spacer" />
      <div className="rail-item" title="Settings">
        <Icon name="settings" size={16} />
      </div>
    </div>
  );
}

function StatusBar() {
  const s = window.SESSION;
  return (
    <div className="statusbar">
      <div className="seg">
        <span className="dot" style={{ background: s ? 'var(--accent)' : 'var(--muted-2)' }} />
        <span className="v">{s ? 'Connected · api.anthropic.com' : 'Idle'}</span>
      </div>
      <div className="seg">
        <span className="k">SESSION</span>
        <span className="v">{s?.id ?? '—'}</span>
      </div>
      <div className="seg">
        <span className="k">ELAPSED</span>
        <span className="v">{s?.elapsed ?? '—'}</span>
      </div>
      <div className="seg">
        <span className="k">CTX</span>
        <span className="v">
          {s ? `${(s.director.contextUsed / 1000).toFixed(1)}k / ${(s.director.contextCap / 1000)}k` : '—'}
        </span>
      </div>
      <div className="spacer" />
      <div className="seg">
        <span className="k">⌘K</span>
        <span className="v">Command bar</span>
      </div>
      <div className="seg">
        <span className="k">⌘N</span>
        <span className="v">New agent</span>
      </div>
      <div className="seg">
        <span className="k">⌘.</span>
        <span className="v">Interrupt</span>
      </div>
    </div>
  );
}

Object.assign(window, { TopBar, LeftRail, StatusBar });
