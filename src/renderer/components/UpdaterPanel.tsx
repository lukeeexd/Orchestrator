import { useEffect, useState } from 'react';
import type {
  UpdaterPrimaryStatus,
  UpdaterStateSnapshot,
} from '../../shared/ipc';
import { Icon } from './Icon';

/**
 * R-U1 (v0.23.0): updater diagnostic surface for the Settings screen.
 *
 * The v0.22.1 post-mortem found `update-electron-app` had likely been
 * silently no-oping for the entire release history of the app — the
 * Squirrel installer logs showed manual `--install .` runs only, never
 * an in-app auto-update activity, and the setup error path was wrapped
 * in a swallowed try/catch. Without UI to see what the updater was
 * doing, "no pill" was indistinguishable from "everything's fine, just
 * no update available."
 *
 * This panel surfaces:
 *   - current status badge (idle / checking / ready / error / ...)
 *   - last status transition time
 *   - last error if any
 *   - a manual "Check for updates now" button that triggers an
 *     immediate primary poll
 *   - "Restart to apply" when a download has completed
 *   - the secondary channel's "Download manually" link as a fallback
 *
 * State arrives via two routes: a one-shot `getUpdaterState` on mount,
 * plus an `onUpdaterStateChanged` subscription for live transitions.
 */

const STATUS_LABELS: Record<UpdaterPrimaryStatus, string> = {
  disabled: 'Disabled (dev build)',
  idle: 'Idle',
  checking: 'Checking for updates…',
  'no-update': 'Up to date',
  available: 'Update found',
  downloading: 'Downloading…',
  ready: 'Ready — restart to apply',
  error: 'Error',
};

const STATUS_TINT: Record<UpdaterPrimaryStatus, string> = {
  disabled: 'var(--muted-2)',
  idle: 'var(--text-2)',
  checking: 'var(--accent)',
  'no-update': 'var(--ok, var(--text-2))',
  available: 'var(--accent)',
  downloading: 'var(--accent)',
  ready: 'var(--ok, var(--accent))',
  error: 'var(--warn, #d24)',
};

function formatRelative(ts: number | undefined): string {
  if (!ts) return '—';
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(ts).toLocaleString();
}

export function UpdaterPanel() {
  const [state, setState] = useState<UpdaterStateSnapshot | null>(null);
  const [checking, setChecking] = useState(false);
  // Ticker so the "Ns ago" rendering refreshes without waiting on the
  // next state event (which may be 10+ minutes away).
  const [, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    void window.api.getUpdaterState().then(setState);
    const off = window.api.onUpdaterStateChanged(setState);
    const tick = setInterval(() => setNow(Date.now()), 5_000);
    return () => {
      off();
      clearInterval(tick);
    };
  }, []);

  const handleCheck = async () => {
    setChecking(true);
    try {
      const next = await window.api.checkForUpdatesNow();
      setState(next);
    } finally {
      // Clear the spinner after the immediate state call returns —
      // the actual poll's `update-available` / `update-not-available`
      // arrives later via the state-changed subscription.
      setTimeout(() => setChecking(false), 1200);
    }
  };

  if (!state) {
    return (
      <section className="settings-section">
        <h3 className="settings-h">Updates</h3>
        <div className="dim">Loading…</div>
      </section>
    );
  }

  const showRestart = state.primaryStatus === 'ready';
  const showSecondaryFallback =
    state.secondaryDownloadUrl && state.primaryStatus !== 'ready';

  return (
    <section className="settings-section">
      <h3 className="settings-h">Updates</h3>

      <div className="field">
        <span className="lbl">Status</span>
        <span className="v" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: STATUS_TINT[state.primaryStatus],
            }}
          />
          <span style={{ color: STATUS_TINT[state.primaryStatus] }}>
            {STATUS_LABELS[state.primaryStatus]}
          </span>
          <span className="dim" style={{ fontSize: 11 }}>
            · updated {formatRelative(state.primaryStatusAt)}
          </span>
        </span>
      </div>

      {!state.setupOk && state.setupError && (
        <div className="field">
          <span className="lbl">Setup error</span>
          <span className="v">
            <code
              style={{
                color: 'var(--warn, #d24)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {state.setupError}
            </code>
          </span>
        </div>
      )}

      {state.primaryLastError && state.setupOk && (
        <div className="field">
          <span className="lbl">Last error</span>
          <span className="v">
            <code
              style={{
                color: 'var(--warn, #d24)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {state.primaryLastError}
            </code>
          </span>
        </div>
      )}

      {state.downloadedVersion && (
        <div className="field">
          <span className="lbl">Downloaded</span>
          <span className="v">
            <code>{state.downloadedVersion}</code>
          </span>
        </div>
      )}

      {state.secondaryVersion && (
        <div className="field">
          <span className="lbl">Manual download</span>
          <span className="v">
            <code>{state.secondaryVersion}</code>
            {state.secondaryDownloadUrl && (
              <span className="dim" style={{ marginLeft: 6, fontSize: 11 }}>
                · GitHub Releases
              </span>
            )}
          </span>
        </div>
      )}

      <div className="field">
        <span className="lbl">Log file</span>
        <span className="v">
          <code>%APPDATA%\Orchestrator\logs\main.log</code>
        </span>
      </div>

      <div
        className="settings-input-row"
        style={{ marginTop: 8, gap: 8, flexWrap: 'wrap' }}
      >
        <button
          className="tb-btn"
          onClick={() => void handleCheck()}
          disabled={checking || state.primaryStatus === 'disabled'}
          title="Force an immediate poll of update.electronjs.org bypassing the 10-minute interval"
        >
          <Icon name="redirect" size={11} />{' '}
          {checking ? 'Checking…' : 'Check for updates now'}
        </button>
        {showRestart && (
          <button
            className="tb-btn primary"
            onClick={() => void window.api.restartToUpdate()}
            title={
              state.downloadedVersion
                ? `Restart to apply ${state.downloadedVersion}`
                : 'Restart to apply the downloaded update'
            }
          >
            <Icon name="check" size={11} /> Restart &amp; install
            {state.downloadedVersion ? ` ${state.downloadedVersion}` : ''}
          </button>
        )}
        {showSecondaryFallback && state.secondaryDownloadUrl && (
          <button
            className="tb-btn"
            onClick={() =>
              void window.api.openSecondaryDownload(
                state.secondaryDownloadUrl as string,
              )
            }
            title="Open the GitHub release page for the newer version — manual install fallback when auto-update isn't working"
          >
            <Icon name="file" size={11} /> Download {state.secondaryVersion} manually
          </button>
        )}
      </div>
    </section>
  );
}
