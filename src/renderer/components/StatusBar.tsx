interface Props {
  agentCount: number;
}

export function StatusBar({ agentCount }: Props) {
  const idle = agentCount === 0;
  return (
    <div className="statusbar">
      <div className="seg">
        <span
          className="dot"
          style={
            idle
              ? { background: 'var(--muted-2)', boxShadow: 'none' }
              : undefined
          }
        />
        <span className="v">{idle ? 'Idle' : `${agentCount} agents`}</span>
      </div>
      <div className="spacer" />
      <div className="seg">
        <span className="k">Ctrl+N</span>
        <span className="v">New agent</span>
      </div>
      <div className="seg">
        <span className="k">Ctrl+.</span>
        <span className="v">Abort selected</span>
      </div>
    </div>
  );
}
