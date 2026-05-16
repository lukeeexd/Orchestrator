import { app, autoUpdater, BrowserWindow } from 'electron';
import { updateElectronApp, UpdateSourceType } from 'update-electron-app';

/**
 * Wire Squirrel.Windows auto-update via update.electronjs.org (which acts
 * as a Squirrel-compatible feed proxy over our GitHub Releases). The
 * `update-electron-app` package is the official wrapper: it polls the
 * feed every 10 minutes by default, downloads new nupkgs in the
 * background, and fires `update-downloaded` on autoUpdater when ready.
 *
 * No-ops in dev mode (process.defaultApp / non-packaged) so dev sessions
 * don't accidentally apply updates over the working copy.
 */
export function setupAutoUpdater(): void {
  if (!app.isPackaged) {
    // Dev/unpackaged build — autoUpdater isn't available and we don't
    // want to ship updates over the user's working copy anyway.
    return;
  }

  try {
    updateElectronApp({
      updateSource: {
        type: UpdateSourceType.ElectronPublicUpdateService,
        repo: 'lukeeexd/Orchestrator',
      },
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
    // If update.electronjs.org returns a 404 (no release yet for this
    // platform/version pair) the wrapper throws. Swallow so app start
    // doesn't fail in that case — auto-update is best-effort.
    console.error('[updater] setup failed:', err);
    return;
  }

  // Bridge the autoUpdater events to the renderer so the status bar can
  // surface "Update vX.Y.Z ready · Restart to apply" once a download
  // finishes. The update-electron-app package wraps autoUpdater but
  // doesn't intercept these events, so we attach our own listeners.
  autoUpdater.on('update-downloaded', (_event, releaseNotes, releaseName) => {
    broadcast('updater:event:update-downloaded', {
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
