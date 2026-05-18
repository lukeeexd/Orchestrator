import { app, BrowserWindow } from 'electron';
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
import { cleanupPastedImagesAtStart } from './attachments';

if (started) {
  app.quit();
}

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
    },
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
  await openDb();
  // Probe each supported CLI on PATH. Stored so the renderer can show a
  // provider-aware "CLI not found" gate before any spawn attempt. Cheap
  // (one subprocess per provider); only runs at startup. The gate
  // checks the active project's provider — a claude-only user with no
  // codex installed isn't blocked unless they create a codex project,
  // and vice versa.
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
  // Any agent left in 'running' state from a previous run is dead now —
  // we can't resume its session. Flip those to 'error: Interrupted'
  // before hydrating so the renderer sees the right state.
  markRunningAgentsAsInterrupted();
  // Wipe any pasted-image temp files left behind by previous sessions.
  // Their associated agent runs are long dead and the files are
  // non-sensitive — best-effort sweep keeps the temp dir from growing
  // without bound.
  cleanupPastedImagesAtStart(
    path.join(app.getPath('temp'), 'orchestrator-paste'),
  );
  ensureDefaultProject();
  director.hydrateAll(listProjects().map((p) => p.id));
  registry.hydrate();
  registerIpcHandlers();
  setupAutoUpdater();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  closeDb();
});
