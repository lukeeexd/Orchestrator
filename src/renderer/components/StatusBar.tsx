import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

interface Props {
  agentCount: number;
}

/**
 * Grace period before the secondary's "Download" pill surfaces.
 *
 * The secondary update channel (S6 from v0.14.1) polls a hosted
 * `latest.json` and signals when a newer version exists. The primary
 * channel polls a Squirrel feed and downloads the new version in the
 * background. Both run on a 10-minute cadence but the secondary
 * normally wins the race because its manifest updates instantly on
 * CI publish while the primary depends on the feed cache + Squirrel's
 * download time.
 *
 * Without the grace period, every release momentarily showed users a
 * confusing "Download" pill (manual install) instead of the
 * "Restart" pill (auto-install) they're used to. The grace period
 * lets the primary finish its download first — only if it doesn't
 * deliver does the secondary surface its fallback affordance.
 *
 * 15 minutes is the sweet spot: long enough for the primary's first
 * poll-cycle (10 min) plus a download buffer; short enough that a
 * genuine primary-channel outage doesn't keep users waiting half an
 * hour on a hotfix release (R-A11).
 */
export const SECONDARY_GRACE_MS = 15 * 60 * 1000;

export function StatusBar({ agentCount }: Props) {
  const idle = agentCount === 0;
  const [updateReady, setUpdateReady] = useState<{
    version: string;
    notes: string;
  } | null>(null);
  const [secondaryUpdate, setSecondaryUpdate] = useState<{
    version: string;
    downloadUrl: string;
  } | null>(null);
  // Flips true after `SECONDARY_GRACE_MS` elapses post-secondary-detect.
  // Reset on each fresh secondary event so an even newer version
  // restarts the clock.
  const [secondaryGraceElapsed, setSecondaryGraceElapsed] = useState(false);
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const off1 = window.api.onUpdateDownloaded((p) => setUpdateReady(p));
    const off2 = window.api.onSecondaryUpdateAvailable((p) => {
      setSecondaryUpdate({ version: p.version, downloadUrl: p.downloadUrl });
      setSecondaryGraceElapsed(false);
      if (graceTimer.current) clearTimeout(graceTimer.current);
      graceTimer.current = setTimeout(() => {
        setSecondaryGraceElapsed(true);
      }, SECONDARY_GRACE_MS);
    });
    return () => {
      off1();
      off2();
      if (graceTimer.current) clearTimeout(graceTimer.current);
    };
  }, []);

  // The primary's "Restart" pill always wins. The secondary's
  // "Download" pill only surfaces when the primary hasn't fired AND
  // the grace period has elapsed — meaning the primary is genuinely
  // failing to deliver, not just racing the secondary.
  const showSecondaryPill =
    !updateReady && secondaryUpdate && secondaryGraceElapsed;

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
      {updateReady && (
        <button
          className="statusbar-update"
          onClick={() => void window.api.restartToUpdate()}
          title={
            updateReady.notes
              ? updateReady.notes.slice(0, 400)
              : 'Restart Orchestrator to apply the downloaded update.'
          }
        >
          <Icon name="check" size={11} />
          <span>Update {updateReady.version || 'ready'} · Restart</span>
        </button>
      )}
      {showSecondaryPill && secondaryUpdate && (
        // Capture the URL + version into locals so the closure isn't
        // dependent on the still-truthy state (R-L1). If a follow-up
        // refactor memoises the handler, the captured locals survive
        // a state flip between render and click.
        (() => {
          const { downloadUrl, version } = secondaryUpdate;
          return (
            <button
              className="statusbar-update"
              onClick={() => void window.api.openSecondaryDownload(downloadUrl)}
              title="The primary auto-update channel hasn't delivered this version in 15 minutes. Click to download manually."
            >
              <Icon name="file" size={11} />
              <span>Update {version} available · Download</span>
            </button>
          );
        })()
      )}
      <div className="seg">
        <span className="k">Ctrl+N</span>
        <span className="v">New agent</span>
      </div>
      <div className="seg">
        <span className="k">Ctrl+.</span>
        <span className="v">Abort selected</span>
      </div>
      <div className="seg">
        <span className="k">Ctrl+B</span>
        <span className="v">Toggle inspector</span>
      </div>
    </div>
  );
}
