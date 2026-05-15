// Agents workspace — center pane with expandable structured-log streams.

function AgentsPane({ selectedId, onSelect, expanded, onToggle }) {
  const [filter, setFilter] = React.useState('all');
  const agents = window.AGENTS;
  const counts = {
    all:      agents.length,
    running:  agents.filter(a => a.status === 'running').length,
    waiting:  agents.filter(a => a.status === 'waiting' || a.status === 'approval').length,
    done:     agents.filter(a => a.status === 'done').length,
  };
  const filtered = filter === 'all' ? agents
    : filter === 'waiting' ? agents.filter(a => a.status === 'waiting' || a.status === 'approval')
    : agents.filter(a => a.status === filter);

  return (
    <div className="pane agents-pane">
      <div className="pane-head">
        <span className="title">Agents <b>· {agents.length} active</b></span>
        <div style={{ marginLeft: 12 }} className="agents-head">
          <div className="filter">
            {['all','running','waiting','done'].map(k => (
              <button key={k}
                className={filter === k ? 'on' : ''}
                onClick={() => setFilter(k)}>
                {k}
                <span className="count">{counts[k]}</span>
              </button>
            ))}
          </div>
        </div>
        <span className="spacer" />
        <button className="tb-btn">
          <Icon name="logs" size={11} /> All logs
        </button>
        <button className="tb-btn primary">
          <Icon name="plus" size={11} /> New agent
          <span className="kbd">⌘N</span>
        </button>
      </div>

      {agents.length === 0 ? (
        <EmptyAgents />
      ) : (
        <div className="agents-list">
          {filtered.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              selected={selectedId === a.id}
              expanded={expanded[a.id]}
              onSelect={() => onSelect(a.id)}
              onToggle={() => onToggle(a.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyAgents() {
  return (
    <div className="empty">
      <div className="empty-glyph"><Icon name="agents" size={28} color="var(--accent)" stroke={1.2} /></div>
      <div className="empty-title">No agents running</div>
      <div className="empty-body">
        Agents are spawned by the Director when you send it a task, or manually
        from a template. Each agent gets its own context, tools, memory, and live log.
      </div>
      <div className="empty-actions">
        <button className="tb-btn primary">
          <Icon name="plus" size={11} /> New agent
          <span className="kbd">⌘N</span>
        </button>
        <button className="tb-btn">
          <Icon name="templates" size={11} /> From template
        </button>
      </div>
    </div>
  );
}

function AgentRow({ agent, selected, expanded, onSelect, onToggle }) {
  return (
    <div className={'agent' + (selected ? ' selected' : '')}>
      <div className="agent-head" onClick={onSelect}>
        <button className="chev" onClick={(e) => { e.stopPropagation(); onToggle(); }}
                style={{ background: 'transparent', border: 0, color: 'var(--muted)', cursor: 'default', padding: 0 }}>
          <Icon name={expanded ? 'chevron-down' : 'chevron'} size={11} />
        </button>
        <span className={'dotled ' + agent.status}><i/></span>
        <span className="agent-id">
          <span className="name">{agent.name}</span>
          <span className="role" style={{ color: ROLE_TINT[agent.role] }}>{agent.roleLabel}</span>
        </span>
        <span className="agent-task">
          <span className="step">[{agent.step}]</span>{agent.task}
        </span>
        <span className="metric">
          <span className="label">tokens</span>
          <span className="val">{(agent.tokens / 1000).toFixed(1)}k</span>
        </span>
        <span className="metric">
          <span className="label">cost</span>
          <span className="val">${agent.cost.toFixed(2)}</span>
        </span>
        <span className="agent-actions">
          <button className="icon-btn" title="Pause"
            onClick={(e) => e.stopPropagation()}>
            <Icon name={agent.status === 'running' ? 'pause' : 'play'} size={11} />
          </button>
        </span>
      </div>

      {expanded && (
        <div className="agent-log">
          <div className="log-divider" />
          {agent.log.map((l, i) => (
            <div className={'log-line ' + l.kind} key={i}>
              <span className="ts">{l.ts}</span>
              <span className="kind">{l.kind}</span>
              <span className="msg">
                <ToolCall msg={l.msg} />
                {l.live && <span className="log-cursor" />}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

Object.assign(window, { AgentsPane });
