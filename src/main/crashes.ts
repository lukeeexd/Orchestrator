import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * S5: local-only crash capture. No network upload, no external service,
 * no opt-in toggle — the same userData directory already holds the
 * agent DB and marketplace cache, so a crash log isn't a fresh privacy
 * surface. If the user ever wants to share a crash report (e.g. file a
 * GitHub issue) they reveal the folder via Settings and copy the JSON
 * themselves.
 *
 * Captures four classes of crash:
 *   - main process: `uncaughtException` + `unhandledRejection`
 *   - main process child gone: `child-process-gone` (e.g. utility processes)
 *   - renderer dead: `render-process-gone`
 *   - renderer thrown but recovered: `RecordRendererCrash` IPC, fired
 *     from the React error boundary
 *
 * Each crash lands as a single JSON file named
 * `<ISO ts>-<short uuid>.json` under `userData/crashes/`. Files are
 * write-once; the only cleanup affordance is "clear all" from
 * Settings.
 */

export type CrashKind =
  | 'main-uncaught'
  | 'main-rejection'
  | 'main-child-gone'
  | 'renderer-process-gone'
  | 'renderer-error-boundary';

export interface CrashEntry {
  /** Filesystem basename (the timestamp-uuid filename without `.json`). */
  id: string;
  ts: string;
  kind: CrashKind;
  appVersion: string;
  electronVersion: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  error: {
    name: string;
    message: string;
    stack?: string;
  };
  /** Free-form context — render URL, process phase, etc. */
  context?: Record<string, unknown>;
}

let crashDirCached: string | null = null;

function crashDir(): string {
  if (crashDirCached) return crashDirCached;
  crashDirCached = path.join(app.getPath('userData'), 'crashes');
  try {
    fs.mkdirSync(crashDirCached, { recursive: true });
  } catch {
    // Best-effort. If we can't write here, the writes below will throw
    // and the original error stays propagated to the host's stderr.
  }
  return crashDirCached;
}

/**
 * Coerce anything thrown into the shape we serialise. Most JS errors
 * are Error instances; non-Error throws (`throw "boom"`, `throw {x:1}`)
 * collapse to `String(value)` so we still get a record on disk.
 */
function normalizeError(value: unknown): CrashEntry['error'] {
  if (value instanceof Error) {
    return {
      name: value.name || 'Error',
      message: value.message || '',
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }
  if (value && typeof value === 'object') {
    const r = value as Record<string, unknown>;
    return {
      name: typeof r.name === 'string' ? r.name : 'NonError',
      message: typeof r.message === 'string' ? r.message : JSON.stringify(r),
      ...(typeof r.stack === 'string' ? { stack: r.stack } : {}),
    };
  }
  return { name: 'NonError', message: String(value) };
}

function writeCrash(
  kind: CrashKind,
  error: CrashEntry['error'],
  context?: Record<string, unknown>,
): void {
  const ts = new Date().toISOString();
  const id = `${ts.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const entry: CrashEntry = {
    id,
    ts,
    kind,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    error,
    ...(context && Object.keys(context).length > 0 ? { context } : {}),
  };
  try {
    fs.writeFileSync(
      path.join(crashDir(), `${id}.json`),
      JSON.stringify(entry, null, 2),
      'utf8',
    );
    // Surface to stderr too — when the crash is happening live, the
    // user (running from a dev terminal) sees something immediately
    // instead of having to dig through the crashes folder.
    process.stderr.write(
      `[crash] ${kind}: ${error.name}: ${error.message}\n`,
    );
  } catch (writeErr) {
    // We're already in a crash path. Don't throw and don't loop —
    // best-effort to stderr.
    process.stderr.write(
      `[crash] failed to persist ${kind}: ${String(writeErr)}\n`,
    );
  }
}

/**
 * Install process-wide handlers. Idempotent — calling twice is a
 * no-op because Node treats each `on(...)` independently and we
 * already deduplicate via the module-level guard.
 *
 * Call this VERY EARLY in main/index.ts — before any other
 * import does work that might throw. The whole point of S5 is to
 * catch boot-time crashes that would otherwise silently kill the
 * app with no UI.
 */
let installed = false;
export function installCrashHandlers(): void {
  if (installed) return;
  installed = true;

  process.on('uncaughtException', (err) => {
    writeCrash('main-uncaught', normalizeError(err));
  });

  process.on('unhandledRejection', (reason) => {
    writeCrash('main-rejection', normalizeError(reason));
  });

  // Defer Electron-API-dependent handlers until `app` is ready so we
  // don't crash on `app.on` before the module is initialised. The
  // process-level handlers above ARE safe pre-ready.
  app.whenReady().then(() => {
    app.on('child-process-gone', (_event, details) => {
      writeCrash(
        'main-child-gone',
        {
          name: 'ChildProcessGone',
          message: `${details.type ?? 'child'} exited (reason=${
            details.reason ?? 'unknown'
          }${details.exitCode != null ? `, code=${details.exitCode}` : ''})`,
        },
        { ...details },
      );
    });
    app.on('render-process-gone', (_event, _webContents, details) => {
      writeCrash(
        'renderer-process-gone',
        {
          name: 'RenderProcessGone',
          message: `renderer gone (reason=${details.reason ?? 'unknown'}${
            details.exitCode != null ? `, code=${details.exitCode}` : ''
          })`,
        },
        { ...details },
      );
    });
  });
}

/**
 * Persist a crash record forwarded from the renderer via IPC.
 * Renderer-side errors caught by the React error boundary land
 * here as plain JSON; we normalise + write through the same
 * pipeline as the process-level handlers.
 */
export function recordRendererCrash(payload: {
  name?: string;
  message?: string;
  stack?: string;
  componentStack?: string;
  url?: string;
}): void {
  writeCrash(
    'renderer-error-boundary',
    {
      name: payload.name || 'RendererError',
      message: payload.message || '(no message)',
      ...(payload.stack ? { stack: payload.stack } : {}),
    },
    {
      ...(payload.componentStack ? { componentStack: payload.componentStack } : {}),
      ...(payload.url ? { url: payload.url } : {}),
    },
  );
}

/** Absolute path to the crashes folder. Cheap; safe to call repeatedly. */
export function getCrashesFolder(): string {
  return crashDir();
}

/**
 * List the crashes on disk, most recent first. Skips junk entries
 * (non-JSON files, malformed JSON). Capped at `limit` so a host
 * with thousands of crashes doesn't drown the Settings UI.
 */
export function listCrashes(limit = 50): CrashEntry[] {
  const dir = crashDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const sorted = names
    .filter((n) => n.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit);
  const out: CrashEntry[] = [];
  for (const n of sorted) {
    try {
      const raw = fs.readFileSync(path.join(dir, n), 'utf8');
      const parsed = JSON.parse(raw) as CrashEntry;
      out.push(parsed);
    } catch {
      // Skip unparseable files — they were probably truncated by a
      // crash mid-write. Best to leave them on disk for forensics.
    }
  }
  return out;
}

/** Delete every `.json` in the crashes folder. Returns the count removed. */
export function clearCrashes(): number {
  const dir = crashDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      fs.unlinkSync(path.join(dir, n));
      removed += 1;
    } catch {
      // Best-effort.
    }
  }
  return removed;
}

/** Returns the count without parsing the JSON bodies. Used by the Settings tile. */
export function countCrashes(): number {
  const dir = crashDir();
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

