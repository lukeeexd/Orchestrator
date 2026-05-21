import { app, autoUpdater, BrowserWindow } from 'electron';
import { updateElectronApp, UpdateSourceType } from 'update-electron-app';

/**
 * v0.15.0: auto-update now polls a self-hosted Squirrel feed on
 * Cloudflare R2 instead of `update.electronjs.org`. The latter is
 * public-repo-only — pointing at our R2 bucket lets us flip the
 * GitHub repo private later without breaking auto-update.
 *
 * The feed bucket lives at this baseUrl and contains:
 *   - RELEASES                                  (Squirrel text index)
 *   - Orchestrator-<version>-full.nupkg         (the update package)
 *   - Orchestrator-Setup.exe                    (first-install link)
 *
 * `release.yml` uploads all three to R2 on every tag via
 * `wrangler r2 object put`. `update-electron-app`'s built-in
 * `StaticStorage` source pattern fetches RELEASES from baseUrl +
 * platform suffix; Electron's autoUpdater then handles the
 * nupkg download + install hand-off.
 *
 * No-ops in dev mode (process.defaultApp / non-packaged) so dev
 * sessions don't accidentally apply updates over the working copy.
 */
const UPDATE_FEED_BASE_URL =
  'https://pub-8063218cce2949b1b3259affce2c51e2.r2.dev';

export function setupAutoUpdater(): void {
  if (!app.isPackaged) {
    // Dev/unpackaged build — autoUpdater isn't available and we don't
    // want to ship updates over the user's working copy anyway.
    return;
  }

  try {
    updateElectronApp({
      updateSource: {
        type: UpdateSourceType.StaticStorage,
        baseUrl: UPDATE_FEED_BASE_URL,
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
