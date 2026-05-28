import logBase from 'electron-log/main';
import { app } from 'electron';
import path from 'node:path';

/**
 * Main-process logger. Writes to a persistent file under
 * `app.getPath('logs')` so failures that happen before any UI is
 * mounted — most importantly the auto-updater's setup path
 * (`updater.ts`) — survive past the next app restart and can be
 * inspected after the fact.
 *
 * Why electron-log: the codebase previously used bare `console.log`
 * for main-process diagnostics, but packaged Electron on Windows
 * discards stdout. Half the auto-updater debugging in the v0.22.1
 * post-mortem boiled down to "we have no idea what the updater
 * actually did because we never wrote it down." This module fixes
 * that for every main-process module that imports `log` instead of
 * touching `console` directly.
 *
 * File location on Windows: `%APPDATA%\Orchestrator\logs\main.log`
 * (or whatever `app.getPath('logs')` resolves to on other platforms).
 * Size-based rotation at 5 MiB keeps the on-disk footprint bounded —
 * older entries roll into `main.old.log` automatically.
 */

const HIGH_VOLUME_BYTES = 5 * 1024 * 1024;

function configure(): void {
  // File transport: explicit path so it doesn't drift if electron-log
  // changes its defaults. `app.getPath('logs')` is guaranteed to
  // exist by Electron before any module-level code runs.
  logBase.transports.file.resolvePathFn = () =>
    path.join(app.getPath('logs'), 'main.log');
  logBase.transports.file.maxSize = HIGH_VOLUME_BYTES;
  logBase.transports.file.format =
    '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {scope} {text}';

  // Console transport stays enabled for `npm start` dev work where
  // stdout IS attached and visible. It's a no-op for the packaged
  // build (no console attached on Windows GUI subsystem) so cheap to
  // leave on.
  logBase.transports.console.format =
    '[{h}:{i}:{s}] [{level}] {scope} {text}';

  // Level: info covers normal operation; verbose / debug are gated
  // by env var for ad-hoc deep-dive sessions without recompiling.
  const envLevel = process.env.ORCHESTRATOR_LOG_LEVEL?.toLowerCase();
  if (
    envLevel === 'silly' ||
    envLevel === 'debug' ||
    envLevel === 'verbose' ||
    envLevel === 'info' ||
    envLevel === 'warn' ||
    envLevel === 'error'
  ) {
    logBase.transports.file.level = envLevel;
    logBase.transports.console.level = envLevel;
  } else {
    logBase.transports.file.level = 'info';
    logBase.transports.console.level = 'info';
  }
}

configure();

/** Default logger — most modules use this. */
export const log = logBase;

/** Scoped logger so log lines can be grepped by subsystem. */
export function scoped(scope: string): ReturnType<typeof logBase.scope> {
  return logBase.scope(scope);
}
