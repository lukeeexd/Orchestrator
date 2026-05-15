export function StatusBar() {
  return (
    <div className="statusbar">
      <div className="seg">
        <span
          className="dot"
          style={{ background: 'var(--muted-2)', boxShadow: 'none' }}
        />
        <span className="v">Idle</span>
      </div>
      <div className="seg">
        <span className="k">SESSION</span>
        <span className="v">—</span>
      </div>
      <div className="seg">
        <span className="k">ELAPSED</span>
        <span className="v">—</span>
      </div>
      <div className="seg">
        <span className="k">CTX</span>
        <span className="v">—</span>
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
