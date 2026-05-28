import { app, autoUpdater, BrowserWindow } from 'electron';
import { updateElectronApp } from 'update-electron-app';
import { IpcChannels } from '../shared/ipc';
import type { UpdaterPrimaryStatus, UpdaterStateSnapshot } from '../shared/ipc';
import { scoped } from './log';

/**
 * Primary auto-update channel: `update-electron-app`'s default
 * `update.electronjs.org` feed (Microsoft-operated, TLS-pinned to
 * GitHub Releases). The v0.15.0 cutover to a self-hosted R2 feed was
 * reverted (R-H2 review finding): because the installer is
 * deliberately unsigned, a compromise of the static-storage feed
 * (token leak, account takeover, DNS) ships code execution to every
 * install on the next 10-minute poll. The Microsoft-operated feed
 * has a much higher compromise bar.
 *
 * `secondaryUpdater.ts` keeps a belt-and-suspenders "new version
 * available" signal via Cloudflare Pages, but signal-only — it
 * never auto-installs.
 *
 * Repo-private remains a separate strategic call: cutting over to a
 * self-hosted feed would require signing the installer first (H7).
 *
 * R-U1 (v0.23.0): every `autoUpdater` event is now mirrored into a
 * module-level state object (`state`), broadcast on
 * `UpdaterEventStateChanged`, persisted by `electron-log`, and
 * surfaced in Settings. Pre-v0.23 the updater's `setup failed` and
 * `error` paths were silent — a swallowed throw at boot left users
 * indistinguishable from "no update available yet."
 *
 * No-ops in dev mode (process.defaultApp / non-packaged) so dev
 * sessions don't accidentally apply updates over the working copy.
 */

const log = scoped('updater');

let state: UpdaterStateSnapshot = {
  appVersion: app.getVersion(),
  setupOk: false,
  primaryStatus: 'idle',
};

function setStatus(
  next: UpdaterPrimaryStatus,
  patch: Partial<UpdaterStateSnapshot> = {},
): void {
  state = {
    ...state,
    ...patch,
    primaryStatus: next,
    primaryStatusAt: Date.now(),
  };
  log.info(`status → ${next}`, patch);
  broadcast(IpcChannels.UpdaterEventStateChanged, state);
}

/** Read-only view of the current updater state. Returned from `UpdaterGetState`. */
export function getUpdaterState(): UpdaterStateSnapshot {
  return { ...state };
}

/**
 * Notify the updater that the secondary channel has reported a newer
 * version. `secondaryUpdater.ts` calls this so the combined state
 * (primary + secondary) lives in one place for the renderer.
 */
export function setSecondaryUpdateInfo(info: {
  version: string;
  downloadUrl: string;
}): void {
  state = {
    ...state,
    secondaryVersion: info.version,
    secondaryDownloadUrl: info.downloadUrl,
  };
  broadcast(IpcChannels.UpdaterEventStateChanged, state);
}

export function setupAutoUpdater(): void {
  if (!app.isPackaged) {
    // Dev/unpackaged build — autoUpdater isn't available and we don't
    // want to ship updates over the user's working copy anyway.
    log.info('skip setup: app is not packaged (dev mode)');
    state = { ...state, primaryStatus: 'disabled' };
    return;
  }

  try {
    updateElectronApp({
      // 10 minutes is the package default; explicit so it's easy to tune.
      updateInterval: '10 minutes',
      // Skip the bundled UpdateDownloaded notification — we surface our
      // own banner in the renderer's status bar so the affordance lives
      // inside the app rather than as a native popup.
      notifyUser: false,
      logger: {
        log: (...args: unknown[]) => log.info(...args),
        info: (...args: unknown[]) => log.info(...args),
        warn: (...args: unknown[]) => log.warn(...args),
        error: (...args: unknown[]) => log.error(...args),
      },
    });
    state = { ...state, setupOk: true };
    log.info('setup complete: feed=update.electronjs.org, interval=10m');
  } catch (err) {
    // R-U1: don't swallow. Surface the failure to the user via state
    // so Settings can show what went wrong instead of leaving them
    // staring at a forever-blank pill.
    const msg = err instanceof Error ? err.message : String(err);
    log.error('setup failed:', msg, err);
    state = {
      ...state,
      setupOk: false,
      setupError: msg,
      primaryStatus: 'error',
      primaryLastError: msg,
      primaryStatusAt: Date.now(),
    };
    broadcast(IpcChannels.UpdaterEventStateChanged, state);
    return;
  }

  // Bridge the autoUpdater events to the renderer so the status bar can
  // surface "Update vX.Y.Z ready · Restart to apply" once a download
  // finishes. The update-electron-app package wraps autoUpdater but
  // doesn't intercept these events, so we attach our own listeners.

  autoUpdater.on('checking-for-update', () => {
    setStatus('checking');
  });

  autoUpdater.on('update-available', () => {
    setStatus('available');
  });

  autoUpdater.on('update-not-available', () => {
    setStatus('no-update');
  });

  autoUpdater.on('update-downloaded', (_event, releaseNotes, releaseName) => {
    const payload = {
      version: typeof releaseName === 'string' ? releaseName : '',
      notes: typeof releaseNotes === 'string' ? releaseNotes : '',
    };
    setStatus('ready', {
      downloadedVersion: payload.version,
      downloadedNotes: payload.notes,
    });
    // Latch: also broadcast the legacy `update-downloaded` event so
    // any StatusBar listener that mounted before this fired still
    // wakes up via the standard route. Late-mounting renderers
    // (which missed THIS broadcast) can call `UpdaterGetState` to
    // pick up the latched `primaryStatus === 'ready'` state instead.
    broadcast(IpcChannels.UpdaterEventDownloaded, payload);
  });

  autoUpdater.on('error', (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('error event:', msg, err);
    setStatus('error', { primaryLastError: msg });
  });
}

/**
 * Force an immediate primary poll. Returns the post-call state
 * snapshot. The actual poll is fire-and-forget — autoUpdater dispatches
 * 'checking-for-update' then 'update-available' / 'update-not-available'
 * asynchronously, and those events flow through the listeners above.
 *
 * Used by the Settings "Check for updates now" button.
 */
export function checkForUpdatesNow(): UpdaterStateSnapshot {
  if (!app.isPackaged) {
    log.info('checkForUpdatesNow: skipped (dev mode)');
    return getUpdaterState();
  }
  if (!state.setupOk) {
    log.warn('checkForUpdatesNow: setup never succeeded, no-op');
    return getUpdaterState();
  }
  try {
    log.info('checkForUpdatesNow: triggering immediate poll');
    autoUpdater.checkForUpdates();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('checkForUpdatesNow failed:', msg, err);
    setStatus('error', { primaryLastError: msg });
  }
  return getUpdaterState();
}

/**
 * Apply a pending update by quitting + restarting via Squirrel. The
 * renderer hands off to this after the user clicks "Restart".
 */
export function quitAndInstallUpdate(): void {
  log.info('quitAndInstall');
  autoUpdater.quitAndInstall();
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}
