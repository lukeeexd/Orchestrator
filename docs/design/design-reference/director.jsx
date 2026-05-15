// Director chat pane — left column.

function DirectorPane({ width }) {
  const s = window.SESSION;
  const messages = window.MESSAGES;
  return (
    <div className="pane director" style={width ? { width } : undefined}>
      <div className="pane-head">
        <span className="title"><b>Director</b></span>
        <span className="meta">{s?.director?.model ?? 'no model selected'}</span>
        <span className="spacer" />
        {s && (
          <span className="meta" title="Context utilisation">
            ctx {(s.director.contextUsed / 1000).toFixed(1)}k
          </span>
        )}
        <button className="icon-btn" title="More"><Icon name="more" size={13} /></button>
      </div>

      {messages.length === 0 ? (
        <EmptyChat />
      ) : (
        <div className="chat">
          {messages.map((m, i) => <Message key={i} {...m} />)}
        </div>
      )}

      <Composer />
    </div>
  );
}

function EmptyChat() {
  return (
    <div className="empty">
      <div className="empty-glyph"><Icon name="director" size={28} color="var(--accent)" stroke={1.2} /></div>
      <div className="empty-title">Awaiting your first task</div>
      <div className="empty-body">
        Describe what you want built, refactored, or investigated.
        The Director will plan the work, spawn agents, and coordinate them.
      </div>
      <div className="empty-hints">
        <span className="empty-hint">“Add Stripe subscriptions to onboarding”</span>
        <span className="empty-hint">“Audit our auth flow for OWASP top-10”</span>
        <span className="empty-hint">“Migrate the docs site from Docusaurus to Mintlify”</span>
      </div>
    </div>
  );
}

function Message({ who, name, time, body, plan, live, children }) {
  return (
    <div className="msg">
      <div className={'msg-head ' + who}>
        <span className="who">{name}</span>
        <span>·</span>
        <span>{time}</span>
        {live && <span style={{ color: 'var(--accent)' }}>· streaming</span>}
      </div>
      {(body || live) && (
        <div className="msg-body">
          {body}
          {live && <span className="log-cursor" />}
        </div>
      )}
      {plan && plan.length > 0 && <PlanCard plan={plan} />}
      {children}
    </div>
  );
}

function PlanCard({ plan }) {
  return (
    <div className="dir-plan">
      <div className="dir-plan-head">
        <span>Plan</span>
        <span className="badge">accepted</span>
      </div>
      {plan.map((p, i) => (
        <div className="plan-row" key={p.name}>
          <span className="num">{String(p.i).padStart(2, '0')}</span>
          <span className="tree">{i === plan.length - 1 ? '└─' : '├─'}</span>
          <span className={'who ' + p.role}>{p.role}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {p.task}
          </span>
        </div>
      ))}
    </div>
  );
}

function Composer() {
  return (
    <div className="composer">
      <div className="composer-input">
        <span className="placeholder">Tell the Director what to do next…</span>
        <span className="caret" />
      </div>
      <div className="composer-bar">
        <span className="chip">
          <Icon name="attach" size={10} /> 0 attachments
        </span>
        <span className="chip">
          <Icon name="branch" size={10} /> main
        </span>
        <span className="chip">@ agent</span>
        <span className="spacer" />
        <span style={{ color: 'var(--muted-2)' }}>⇧↵ newline</span>
        <button className="tb-btn primary" style={{ height: 22 }}>
          <Icon name="send" size={11} /> Send
          <span className="kbd">↵</span>
        </button>
      </div>
    </div>
  );
}

Object.assign(window, { DirectorPane });
