// Right-side agent detail drawer.

function Drawer({ agent, width }) {
  const [tab, setTab] = React.useState('logs');
  if (!agent) {
    return (
      <div className="drawer" style={width ? { width } : undefined}>
        <div className="empty" style={{ height: '100%' }}>
          <div className="empty-glyph"><Icon name="agents" size={24} color="var(--muted)" stroke={1.2} /></div>
          <div className="empty-title" style={{ color: 'var(--text-2)' }}>No agent selected</div>
          <div className="empty-body">
            Click any agent in the workspace to inspect its tools, memory, context,
            and live log. Hit <code>⌘1</code>–<code>⌘9</code> to jump.
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="drawer" style={width ? { width } : undefined}>
      <div className="drawer-head">
        <div className="drawer-id">
          <div className="sigil" style={{ color: ROLE_TINT[agent.role] }}>
            <Icon name={agent.role === 'coder' ? 'tools' : 'agents'} size={16} color={ROLE_TINT[agent.role]} />
          </div>
          <div className="who">
            <span className="name">{agent.name}</span>
            <span className="meta">{agent.roleLabel} · {agent.model}</span>
          </div>
          <span className="spacer" />
          <span className={'pill ' + agent.status}>{agent.statusLabel}</span>
        </div>

        <div className="drawer-kpis">
          <div className="kpi">
            <div className="label">Step</div>
            <div className="val">{agent.step}</div>
          </div>
          <div className="kpi">
            <div className="label">Tokens</div>
            <div className="val">{(agent.tokens / 1000).toFixed(1)}<span style={{ fontSize: 11, color: 'var(--muted)' }}>k</span></div>
          </div>
          <div className="kpi">
            <div className="label">Cost</div>
            <div className="val">${agent.cost.toFixed(2)}</div>
          </div>
          <div className="kpi">
            <div className="label">Elapsed</div>
            <div className="val">{agent.elapsed}</div>
          </div>
        </div>

        <div className="drawer-actions">
          <button className="tb-btn"><Icon name="pause" size={11} /> Pause</button>
          <button className="tb-btn"><Icon name="redirect" size={11} /> Redirect</button>
          <button className="tb-btn"><Icon name="fork" size={11} /> Fork</button>
          <button className="tb-btn primary"><Icon name="check" size={11} /> Approve</button>
        </div>
      </div>

      <div className="tabs">
        {[
          { id: 'logs',    label: 'Logs',    count: agent.log?.length },
          { id: 'tools',   label: 'Tools',   count: window.TOOLS_FOR_AGENT.length },
          { id: 'memory',  label: 'Memory',  count: window.MEMORY.length },
          { id: 'context', label: 'Context', count: window.CONTEXT_FILES.length },
          { id: 'config',  label: 'Config' },
        ].map(t => (
          <div key={t.id} className={'tab' + (tab === t.id ? ' active' : '')} onClick={() => setTab(t.id)}>
            {t.label}
            {t.count != null && <span className="count">{t.count}</span>}
          </div>
        ))}
      </div>

      <div className="drawer-body">
        {tab === 'logs'    && <DrawerLogs agent={agent} />}
        {tab === 'tools'   && <DrawerTools />}
        {tab === 'memory'  && <DrawerMemory />}
        {tab === 'context' && <DrawerContext />}
        {tab === 'config'  && <DrawerConfig agent={agent} />}
      </div>
    </div>
  );
}

function DrawerLogs({ agent }) {
  return (
    <>
      <div className="field">
        <span className="lbl">Current task</span>
        <span className="v">{agent.task}</span>
      </div>
      <div className="field">
        <span className="lbl">Live log</span>
        {agent.log && agent.log.length > 0 ? (
          <div className="agent-log" style={{ padding: 8, background: 'var(--sub)', border: '1px solid var(--border)', borderRadius: 6 }}>
            {agent.log.slice(-8).map((l, i) => (
              <div className={'log-line ' + l.kind} key={i} style={{ gridTemplateColumns: '80px 60px 1fr' }}>
                <span className="ts">{l.ts.slice(0, 8)}</span>
                <span className="kind">{l.kind}</span>
                <span className="msg">
                  <ToolCall msg={l.msg} />
                  {l.live && <span className="log-cursor" />}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="inline-empty">No log entries yet — waiting for the first turn.</div>
        )}
      </div>
    </>
  );
}

function DrawerTools() {
  const tools = window.TOOLS_FOR_AGENT;
  return (
    <>
      <div className="field">
        <span className="lbl">Granted toolset</span>
      </div>
      {tools.length === 0 ? (
        <div className="inline-empty">No tools granted to this agent yet.</div>
      ) : tools.map(t => (
        <div className="tool-row" key={t.name}>
          <span className="ic"><Icon name="tools" size={12} color="var(--accent)" /></span>
          <span className="name"><span className="ns">{t.ns}.</span>{t.name}</span>
          <span className="count">{t.count}×</span>
          <span className="lastuse">{t.last}</span>
        </div>
      ))}
    </>
  );
}

function DrawerMemory() {
  const memory = window.MEMORY;
  return (
    <>
      <div className="field">
        <span className="lbl">Pinned by parent · auto-injected each turn</span>
      </div>
      {memory.length === 0 ? (
        <div className="inline-empty">No memory yet. Agents pin facts from each turn.</div>
      ) : memory.map((m, i) => (
        <div className="mem-card" key={i}>
          <div className="h">
            <Icon name="pin" size={10} color={m.kind === 'pin' ? 'var(--accent)' : 'var(--muted)'} />
            <span className="kind">{m.kind}</span>
            <span style={{ color: 'var(--muted-2)' }}>·</span>
            <span>{m.who}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--muted-2)' }}>{m.at}</span>
          </div>
          <div className="b">{m.body}</div>
        </div>
      ))}
    </>
  );
}

function DrawerContext() {
  const segs = window.CTX_SEGS;
  const files = window.CONTEXT_FILES;
  const total = segs.reduce((s, x) => s + x.pct, 0) || 1;
  return (
    <>
      <div className="field">
        <span className="lbl">Context window</span>
        {segs.length > 0 && (
          <>
            <div className="ctx-bar">
              {segs.map((s, i) => (
                <div key={i} className="ctx-seg"
                  style={{ width: `${(s.pct / total) * 100}%`, background: s.color }} />
              ))}
            </div>
            <div className="ctx-legend">
              {segs.map((s, i) => (
                <span key={i}>
                  <span className="sw" style={{ background: s.color }} />
                  {s.label} · {s.pct}%
                </span>
              ))}
            </div>
          </>
        )}
        {segs.length === 0 && (
          <div className="inline-empty">No context loaded yet.</div>
        )}
      </div>

      <div className="field">
        <span className="lbl">Files in context · {files.length}</span>
        {files.length === 0 ? (
          <div className="inline-empty">No files yet.</div>
        ) : files.map((f, i) => (
          <div className="ctx-file" key={i}>
            <Icon name={f.pinned ? 'pin' : 'file'} size={11}
              color={f.pinned ? 'var(--accent)' : 'var(--muted)'} />
            <span className="path">{f.path}</span>
            <span className="tk">{f.tk.toLocaleString()} tk</span>
          </div>
        ))}
      </div>
    </>
  );
}

function DrawerConfig({ agent }) {
  return (
    <>
      <div className="field">
        <span className="lbl">System prompt</span>
        <div className="sys-prompt">
          {/* Render the agent's system prompt here. */}
          —
        </div>
      </div>
      <div className="field">
        <span className="lbl">Model</span>
        <span className="v"><code>{agent.model ?? '—'}</code></span>
      </div>
      <div className="field">
        <span className="lbl">Limits</span>
        <span className="v">budget · tokens · wall clock</span>
      </div>
      <div className="field">
        <span className="lbl">On error</span>
        <span className="v">retry · escalate to director · halt</span>
      </div>
    </>
  );
}

Object.assign(window, { Drawer });
