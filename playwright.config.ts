import { defineConfig } from '@playwright/test';

// S8: E2E smoke harness.
// Only a small set of specs live under tests/e2e — they launch the
// PACKAGED Electron app (`out/Orchestrator-win32-x64/Orchestrator.exe`)
// not the dev server, because the regressions worth catching here
// (silent fuse-init failures, broken preload, white screen of death
// after a renderer build change) only show up against the real
// build artifact. `npm run package` must run first.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
});
