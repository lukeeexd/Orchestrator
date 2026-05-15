import { Icon } from './Icon';

interface Props {
  width: number;
}

export function DirectorPane({ width }: Props) {
  return (
    <div className="pane director" style={{ width }}>
      <div className="pane-head">
        <span className="title">
          <b>Director</b>
        </span>
        <span className="meta">no model selected</span>
        <span className="spacer" />
        <button className="icon-btn" title="More">
          <Icon name="more" size={13} />
        </button>
      </div>

      <EmptyChat />
      <Composer />
    </div>
  );
}

function EmptyChat() {
  return (
    <div className="empty">
      <div className="empty-glyph">
        <Icon name="director" size={28} color="var(--accent)" stroke={1.2} />
      </div>
      <div className="empty-title">Awaiting your first task</div>
      <div className="empty-body">
        Describe what you want built, refactored, or investigated. The Director
        will plan the work, spawn agents, and coordinate them.
      </div>
      <div className="empty-hints">
        <span className="empty-hint">
          “Add Stripe subscriptions to onboarding”
        </span>
        <span className="empty-hint">
          “Audit our auth flow for OWASP top-10”
        </span>
        <span className="empty-hint">
          “Migrate the docs site from Docusaurus to Mintlify”
        </span>
      </div>
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
