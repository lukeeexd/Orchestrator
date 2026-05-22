import { app, autoUpdater, BrowserWindow } from 'electron';
import { updateElectronApp } from 'update-electron-app';
import { IpcChannels } from '../shared/ipc';

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
 * No-ops in dev mode (process.defaultApp / non-packaged) so dev
 * sessions don't accidentally apply updates over the working copy.
 */
export function setupAutoUpdater(): void {
  if (!app.isPackaged) {
    // Dev/unpackaged build — autoUpdater isn't available and we don't
    // want to ship updates over the user's working copy anyway.
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
        log: (...args: unknown[]) => console.log('[updater]', ...args),
        info: (...args: unknown[]) => console.log('[updater]', ...args),
        warn: (...args: unknown[]) => console.warn('[updater]', ...args),
        error: (...args: unknown[]) => console.error('[updater]', ...args),
      },
    });
  } catch (err) {
    // Feed unreachable or RELEASES not yet uploaded for this version —
    // swallow so app start doesn't fail. Auto-update is best-effort.
    console.error('[updater] setup failed:', err);
    return;
  }

  // Bridge the autoUpdater events to the renderer so the status bar can
  // surface "Update vX.Y.Z ready · Restart to apply" once a download
  // finishes. The update-electron-app package wraps autoUpdater but
  // doesn't intercept these events, so we attach our own listeners.
  autoUpdater.on('update-downloaded', (_event, releaseNotes, releaseName) => {
    broadcast(IpcChannels.UpdaterEventDownloaded, {
      version: releaseName,
      notes: typeof releaseNotes === 'string' ? releaseNotes : '',
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] error event:', err);
  });
}

/**
 * Apply a pending update by quitting + restarting via Squirrel. The
 * renderer hands off to this after the user clicks "Restart".
 */
export function quitAndInstallUpdate(): void {
  autoUpdater.quitAndInstall();
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}
