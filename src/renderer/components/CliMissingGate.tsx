import { useEffect, useState } from 'react';
import { Icon } from './Icon';

/**
 * Blocking overlay shown when the user's machine doesn't have the
 * `claude` CLI on PATH. From v0.4.0 onwards Orchestrator shells out to
 * the user's installed CLI instead of bundling a 200MB native binary,
 * so a missing CLI means nothing will work — the user has to install
 * it before doing anything else.
 *
 * Polls every 5s while open so the user can install and have the gate
 * auto-dismiss without having to restart the app.
 */
export function CliMissingGate({ onResolved }: { onResolved: () => void }) {
  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const check = async () => {
      setChecking(true);
      try {
        const status = await window.api.getClaudeCliStatus();
        if (status.available) {
          setVersion(status.version);
          // Brief celebration before clearing — feels less abrupt than
          // a hard cut, and confirms the version they just installed.
          setTimeout(() => onResolved(), 400);
        }
      } finally {
        setChecking(false);
      }
    };
    void check();
    const t = setInterval(() => void check(), 5000);
    return () => clearInterval(t);
  }, [onResolved]);

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal-head">
          <span className="title">
            <b>Claude CLI not found</b>
          </span>
        </div>
        <div className="modal-body" style={{ gap: 12 }}>
          <p style={{ margin: 0, color: 'var(--text)', fontSize: 13 }}>
            Orchestrator runs your fleet by shelling out to the{' '}
            <code>claude</code> command from Anthropic&apos;s official CLI.
            It isn&apos;t on your PATH right now, so nothing can be spawned.
          </p>
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: 12 }}>
            Install Claude Code, then leave this window open — it&apos;ll
            detect the CLI within a few seconds and unlock itself.
          </p>
          <div
            className="field"
            style={{
              padding: 12,
              background: 'var(--sub)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
            }}
          >
            <div style={{ color: 'var(--muted)', marginBottom: 6 }}>
              Quick install:
            </div>
            <div>npm install -g @anthropic-ai/claude-code</div>
            <div style={{ color: 'var(--muted-2)', marginTop: 8, fontSize: 11 }}>
              or visit{' '}
              <code>https://docs.claude.com/en/docs/claude-code</code> for the
              official installer.
            </div>
          </div>
          {version && (
            <div
              style={{
                padding: 8,
                background: 'rgba(74, 222, 128, 0.08)',
                border: '1px solid rgba(74, 222, 128, 0.3)',
                borderRadius: 6,
                color: 'var(--accent)',
                fontSize: 12,
              }}
            >
              <Icon name="check" size={11} /> Detected: <code>{version}</code>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <span className="meta" style={{ color: 'var(--muted)' }}>
            {checking ? 'Checking…' : 'Auto-rechecks every 5s'}
          </span>
        </div>
      </div>
    </div>
  );
}
