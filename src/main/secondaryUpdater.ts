import { app, BrowserWindow } from 'electron';
import { IpcChannels } from '../shared/ipc';

/**
 * S6: secondary update channel.
 *
 * Polls a hosted `latest.json` manifest at a configured URL. When the
 * manifest reports a newer version than the running app, broadcasts
 * `UpdaterEventSecondaryAvailable` so the renderer can surface a
 * "Update available — download manually" banner with a one-click
 * external link.
 *
 * This is NOT a second auto-installer running alongside the primary
 * update-electron-app — having two updaters compete for the same
 * install is brittle. The secondary channel's job is purely
 * **signalling**: tell the user "an update exists and the primary
 * channel isn't delivering it; here's a download URL." The user
 * runs the installer manually.
 *
 * The expected `latest.json` shape (uploaded to Cloudflare Pages
 * by `.github/workflows/release.yml` on each tag):
 *
 *     {
 *       "version": "0.14.0",
 *       "downloadUrl": "https://orchestrator-updates.pages.dev/Orchestrator-Setup.exe",
 *       "releasedAt": "2026-05-21T13:25:00Z"
 *     }
 *
 * No-op in dev / unpackaged builds — same guard as the primary
 * updater. No-op when the URL is empty, so the secondary stays
 * dormant until Cloudflare is provisioned and `SECONDARY_FEED_URL`
 * is filled in below.
 */

// Cloudflare Pages URL where the workflow publishes latest.json.
// Polling 404s harmlessly until the workflow has run once and
// `latest.json` exists at this host (the release.yml "Publish to
// Cloudflare Pages" step uploads on each tag, gated on the
// CLOUDFLARE_PAGES_PROJECT repo variable being set).
const SECONDARY_FEED_URL = 'https://orchestrator-updates.pages.dev';

// Poll cadence — same 10-minute window as the primary updater, so
// a user with both channels active sees roughly the same signal.
const POLL_INTERVAL_MS = 10 * 60 * 1000;

interface LatestManifest {
  version: string;
  downloadUrl: string;
  releasedAt?: string;
}

interface SecondaryUpdateEvent {
  version: string;
  downloadUrl: string;
  releasedAt?: string;
}

// `latest.json` is a tiny JSON manifest (a few hundred bytes in practice).
// Cap the fetch body so a compromised Pages bucket can't slow-exhaust
// process memory with a many-MB payload every 10 minutes (R-A1).
const MAX_MANIFEST_BYTES = 64 * 1024;

let timer: NodeJS.Timeout | null = null;
let firstPollTimer: NodeJS.Timeout | null = null;

export function setupSecondaryUpdater(): void {
  if (!app.isPackaged) {
    // Dev/unpackaged build — match the primary updater's guard so a
    // dev session doesn't get a stale-version banner.
    return;
  }
  if (!SECONDARY_FEED_URL) {
    // Cloudflare not yet provisioned — leave the secondary dormant.
    return;
  }

  // First poll after a 30s settle so we don't race the renderer's
  // initial mount + the primary updater's first check. Tracked so
  // stopSecondaryUpdater can cancel it before it fires (R-L5).
  firstPollTimer = setTimeout(() => {
    firstPollTimer = null;
    void pollOnce();
  }, 30_000);
  timer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
}

async function pollOnce(): Promise<void> {
  let manifest: LatestManifest | null = null;
  try {
    const res = await fetch(`${SECONDARY_FEED_URL.replace(/\/$/, '')}/latest.json`, {
      cache: 'no-store',
      headers: { 'User-Agent': `Orchestrator/${app.getVersion()} (secondary-updater)` },
    });
    if (!res.ok) {
      console.warn('[secondary-updater] feed returned', res.status);
      return;
    }
    // Refuse oversize payloads before buffering them into memory.
    const declaredLen = Number(res.headers.get('content-length') ?? '0');
    if (declaredLen > MAX_MANIFEST_BYTES) {
      console.warn(
        `[secondary-updater] manifest too large (${declaredLen} bytes)`,
      );
      return;
    }
    manifest = (await res.json()) as LatestManifest;
  } catch (err) {
    console.warn('[secondary-updater] poll failed:', err);
    return;
  }

  if (
    !manifest ||
    typeof manifest.version !== 'string' ||
    typeof manifest.downloadUrl !== 'string'
  ) {
    console.warn('[secondary-updater] malformed manifest');
    return;
  }

  if (!isNewer(manifest.version, app.getVersion())) {
    return;
  }

  const payload: SecondaryUpdateEvent = {
    version: manifest.version,
    downloadUrl: manifest.downloadUrl,
    ...(manifest.releasedAt ? { releasedAt: manifest.releasedAt } : {}),
  };
  broadcast(IpcChannels.UpdaterEventSecondaryAvailable, payload);
}

/**
 * Semver compare. Returns true when `candidate` is strictly greater
 * than `current`. Treats malformed inputs as not-newer so we don't
 * fire a banner for garbage. Exported for unit testing.
 *
 * Compares up to four segments (`major.minor.patch.hotfix`) — Squirrel
 * / electron-updater happily consumes 4-part versions, and the previous
 * 3-segment-only comparison silently returned false for any 4-part
 * candidate (R-A6).
 */
export function isNewer(candidate: string, current: string): boolean {
  const c = candidate.split('.').map((n) => parseInt(n, 10));
  const r = current.split('.').map((n) => parseInt(n, 10));
  if (c.length < 3 || r.length < 3) return false;
  const n = Math.max(c.length, r.length);
  for (let i = 0; i < n; i++) {
    const ci = c[i] ?? 0;
    const ri = r[i] ?? 0;
    if (Number.isNaN(ci) || Number.isNaN(ri)) return false;
    if (ci !== ri) return ci > ri;
  }
  return false;
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

/** Called from the renderer event handler for testing / future deactivation. */
export function stopSecondaryUpdater(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (firstPollTimer) {
    clearTimeout(firstPollTimer);
    firstPollTimer = null;
  }
}
