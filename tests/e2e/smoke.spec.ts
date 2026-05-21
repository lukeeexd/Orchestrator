import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';

// S8 smoke. The only regressions this is meant to catch are big ones —
// build artifact won't start, window opens but renderer never mounts,
// preload throws synchronously, or the asar-integrity fuses are flipped
// back on and silently kill the process before any UI (v0.4.0 bug).
// Anything subtler belongs in unit/integration tests.
//
// We connect via `--remote-debugging-port` (Chromium CDP) instead of
// Playwright's `_electron.launch`, because the latter passes `--inspect`
// which our `EnableNodeCliInspectArguments: false` fuse rejects, leaving
// the launch hung. CDP is a Chromium-layer flag with no fuse interaction
// so the build under test stays identical to what we ship.

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PACKAGED_EXE = path.join(
  REPO_ROOT,
  'out',
  'Orchestrator-win32-x64',
  'Orchestrator.exe',
);
// Hard-coded port. Single-worker run, never overlaps with itself.
const CDP_PORT = 9222;

let proc: ChildProcess;
let context: BrowserContext;
let win: Page;
let userDataDir: string;

async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else reject(new Error(`HTTP ${res.statusCode}`));
        });
        req.on('error', reject);
        req.setTimeout(1000, () => req.destroy(new Error('http timeout')));
      });
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(
    `CDP did not come up on port ${port} within ${timeoutMs}ms (last error: ${String(lastErr)})`,
  );
}

test.beforeAll(async () => {
  if (!fs.existsSync(PACKAGED_EXE)) {
    throw new Error(
      `Packaged app not found at ${PACKAGED_EXE}. Run \`npm run package\` first.`,
    );
  }

  // Isolated userData per run so the smoke never touches the real
  // settings.json / orchestrator.db / marketplace cache.
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-e2e-'));

  proc = spawn(
    PACKAGED_EXE,
    [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`],
    { stdio: 'ignore', windowsHide: true, detached: false },
  );

  await waitForCdp(CDP_PORT, 30_000);

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  context = browser.contexts()[0];

  const pages = context.pages();
  if (pages.length > 0) {
    win = pages[0];
  } else {
    win = await context.waitForEvent('page', { timeout: 15_000 });
  }
  await win.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  try {
    await context?.browser()?.close();
  } catch {
    // Already gone — ignore.
  }
  if (proc && !proc.killed) {
    proc.kill();
    await new Promise((r) => setTimeout(r, 500));
  }
  if (userDataDir && fs.existsSync(userDataDir)) {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Best-effort; Electron may still hold a handle briefly.
    }
  }
});

test('main window opens with Orchestrator title', async () => {
  // Title comes from index.html and is the cheapest signal that the
  // renderer process actually loaded the bundle.
  await expect.poll(() => win.title(), { timeout: 15_000 }).toBe('Orchestrator');
});

test('renderer mounts (root has content)', async () => {
  // `#root` is the React mount node. If the renderer crashed on boot
  // or the preload bridge failed, this stays empty.
  const root = win.locator('#root');
  await expect(root).toBeVisible();
  await expect.poll(
    async () => (await root.innerHTML()).length,
    { timeout: 15_000 },
  ).toBeGreaterThan(0);
});
