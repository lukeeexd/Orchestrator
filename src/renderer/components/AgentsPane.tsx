import { Icon } from './Icon';

export function AgentsPane() {
  return (
    <div className="pane agents-pane">
      <div className="pane-head">
        <span className="title">
          Agents <b>· 0 active</b>
        </span>
        <span className="spacer" />
        <button className="tb-btn">
          <Icon name="logs" size={11} /> All logs
        </button>
        <button className="tb-btn primary">
          <Icon name="plus" size={11} /> New agent
          <span className="kbd">⌘N</span>
        </button>
      </div>

      <EmptyAgents />
    </div>
  );
}

function EmptyAgents() {
  return (
    <div className="empty">
      <div className="empty-glyph">
        <Icon name="agents" size={28} color="var(--accent)" stroke={1.2} />
      </div>
      <div className="empty-title">No agents running</div>
      <div className="empty-body">
        Agents are spawned by the Director when you send it a task, or manually
        from a template. Each agent gets its own context, tools, memory, and
        live log.
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
