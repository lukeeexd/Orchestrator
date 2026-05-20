import { app, BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { registerIpcHandlers } from './ipc';
import { openDb, closeDb } from './db';
import { markRunningAgentsAsInterrupted } from './persistence';
import * as director from './director/runner';
import * as registry from './agents/registry';
import { ensureDefaultProject, listProjects } from './projects';
import { probeCli } from './cli/spawn';
import { setCliStatus } from './cli/status';
import { setupAutoUpdater } from './updater';
import { cleanupPastedImagesAtStart, pasteTempDir } from './attachments';
import * as marketplace from './marketplace';
import { seedBuiltins as seedBuiltinTemplates } from './templates';

if (started) {
  app.quit();
}

/**
 * Flipped in `before-quit` so the fire-and-forget marketplace sync can
 * bail before it touches a closed DB. A clone takes seconds; if the
 * user quits during one, the loop would otherwise call
 * `recordSourceSync` → `getDb()` → `db not opened` after `closeDb()`
 * has run.
 */
let appQuitting = false;

const createWindow = (): void => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#08090b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // M1: lock down the renderer surface.
      //   - sandbox: chromium renderer sandbox on top of the
      //     contextIsolation barrier. Limits what a compromised
      //     renderer can do even before it tries to bypass the
      //     preload bridge.
      //   - webSecurity / allowRunningInsecureContent: defaults are
      //     already secure, but pinning them stops a future
      //     accidental override from quietly opening a hole.
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  // M1: deny window.open and refuse to navigate the main window
  // away from the local app URL. Without these, a click on a
  // file:// link in any rendered agent output could navigate the
  // window to that path. Errors → log + ignore; we don't show
  // anything in-app because legitimate code never trips this.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const allowed =
      MAIN_WINDOW_VITE_DEV_SERVER_URL &&
      url.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    if (!allowed) event.preventDefault();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
  // DevTools stays available via Ctrl+Shift+I / F12; don't auto-open it.
};

app.whenReady().then(async () => {
  // Anything inside `whenReady` runs in a Promise. Without a try/catch
  // a rejection (corrupt sqlite, missing sql-wasm, bad migration)
  // leaves the app silently running with no window, no IPC, no
  // visible error — just an "unhandled rejection" warning in stderr
  // that the user never sees. Surface failures via a native dialog
  // and quit cleanly so the diagnostic isn't buried.
  try {
    await openDb();
    // Probe each supported CLI on PATH. Stored so the renderer can show
    // a provider-aware "CLI not found" gate before any spawn attempt.
    // Cheap (one subprocess per provider); only runs at startup. The
    // gate checks the active project's provider — a claude-only user
    // with no codex installed isn't blocked unless they create a codex
    // project, and vice versa.
    const [claudeVersion, codexVersion] = await Promise.all([
      probeCli('claude', process.env),
      probeCli('codex', process.env),
    ]);
    setCliStatus('claude', {
      available: claudeVersion !== null,
      version: claudeVersion,
    });
    setCliStatus('codex', {
      available: codexVersion !== null,
      version: codexVersion,
    });
    // Any agent left in 'running' state from a previous run is dead
    // now — we can't resume its session. Flip those to
    // 'error: Interrupted' before hydrating so the renderer sees the
    // right state.
    markRunningAgentsAsInterrupted();
    // Wipe any pasted-image temp files left behind by previous
    // sessions. Their associated agent runs are long dead and the
    // files are non-sensitive — best-effort sweep keeps the temp dir
    // from growing without bound.
    cleanupPastedImagesAtStart(pasteTempDir());
    ensureDefaultProject();
    director.hydrateAll(listProjects().map((p) => p.id));
    registry.hydrate();
    registerIpcHandlers();
    setupAutoUpdater();
    // Seed the default skill marketplace (idempotent — INSERT OR
    // IGNORE) and fire async syncs for any source that hasn't been
    // refreshed in 24h. Fire-and-forget — git clone takes a moment
    // and we don't want it blocking the UI. Errors get logged but
    // don't surface as a user-facing failure: the user can hit
    // Refresh manually if needed.
    marketplace.ensureSource({
      id: 'alirezarezvani/claude-skills',
      repo: 'alirezarezvani/claude-skills',
      defaultBranch: 'main',
    });
    void syncStaleMarketplaceSources();
    // Idempotent — INSERT OR IGNORE; runs on every boot to make sure
    // the built-ins are present after a fresh install / v20 migration.
    seedBuiltinTemplates();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? `\n\n${err.stack}` : '';
    console.error('[startup] fatal:', err);
    dialog.showErrorBox(
      'Orchestrator failed to start',
      `Startup error:\n\n${msg}${stack}`,
    );
    app.quit();
  }
});

async function syncStaleMarketplaceSources(): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const sources = marketplace.listSources();
  for (const source of sources) {
    // A clone can take several seconds. If the user has quit (the
    // `before-quit` handler has fired and closeDb() is done), bail
    // before touching the DB again — recordSourceSync would otherwise
    // throw `db not opened` into a `.catch`-less promise.
    if (appQuitting) return;
    if (!source.enabled) continue;
    if (source.lastSyncAt && source.lastSyncAt > cutoff) continue;
    try {
      const { sha } = await marketplace.syncSource(source);
      if (appQuitting) return;
      marketplace.recordSourceSync(source.id, sha, Date.now());
    } catch (e) {
      // Network failure, git not on PATH, etc — log and move on. The
      // user can hit Refresh manually from the Marketplace screen and
      // see the same error inline.
      console.error(
        `[marketplace] startup sync failed for ${source.id}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  appQuitting = true;
  closeDb();
});
