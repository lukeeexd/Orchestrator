import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { registerIpcHandlers } from './ipc';
import { openDb, closeDb } from './db';
import { markRunningAgentsAsInterrupted } from './persistence';
import * as director from './director/runner';
import * as registry from './agents/registry';
import { ensureDefaultProject, listProjects } from './projects';
import { probeClaudeCli } from './cli/spawn';
import { setClaudeCliStatus } from './cli/status';
import { setupAutoUpdater } from './updater';

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
  // Probe for the `claude` CLI on PATH. Stored so the renderer can show
  // a "Claude CLI not found" gate before the user tries to spawn anything.
  // Cheap (one subprocess); only runs at startup.
  const version = await probeClaudeCli(process.env);
  setClaudeCliStatus({ available: version !== null, version });
  // Any agent left in 'running' state from a previous run is dead now —
  // we can't resume its session. Flip those to 'error: Interrupted'
  // before hydrating so the renderer sees the right state.
  markRunningAgentsAsInterrupted();
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
