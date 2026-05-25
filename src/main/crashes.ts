import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import { getDb, isDbOpen } from './db';
import { scrubSecrets } from './secretScrubber';

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

// R-A3: per-process write cap. An infinite-loop in componentDidCatch
// (or a runaway setInterval throw) would otherwise spam the crashes
// folder with thousands of entries. We cap writes per rolling hour;
// further crashes during the cap window land on stderr only.
const WRITE_CAP_PER_HOUR = 100;
const WRITE_CAP_WINDOW_MS = 60 * 60 * 1000;
const writeTimes: number[] = [];

function shouldWrite(now: number): boolean {
  const cutoff = now - WRITE_CAP_WINDOW_MS;
  while (writeTimes.length > 0 && writeTimes[0] < cutoff) {
    writeTimes.shift();
  }
  if (writeTimes.length >= WRITE_CAP_PER_HOUR) return false;
  writeTimes.push(now);
  return true;
}

function writeCrash(
  kind: CrashKind,
  error: CrashEntry['error'],
  context?: Record<string, unknown>,
): void {
  if (!shouldWrite(Date.now())) {
    // Hit the rolling cap — surface to stderr but don't grow the file
    // count further. The original throw still hit stderr above (process
    // listeners) or via the React boundary's render fallback.
    process.stderr.write(
      `[crash] write-cap reached (${WRITE_CAP_PER_HOUR}/h); dropping ${kind}: ${error.name}: ${error.message}\n`,
    );
    return;
  }
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
const RENDERER_COMPONENT_STACK_CAP = 4096;

export function recordRendererCrash(payload: {
  name?: string;
  message?: string;
  stack?: string;
  componentStack?: string;
  url?: string;
}): void {
  // R-A3: cap componentStack at 4 KB. A deep React tree's stack can
  // run many KB; combined with the IPC zod cap this is belt-and-
  // braces protection for the on-disk JSON.
  const stack = payload.componentStack
    ? payload.componentStack.length > RENDERER_COMPONENT_STACK_CAP
      ? payload.componentStack.slice(0, RENDERER_COMPONENT_STACK_CAP) + '…'
      : payload.componentStack
    : undefined;
  writeCrash(
    'renderer-error-boundary',
    {
      name: payload.name || 'RendererError',
      message: payload.message || '(no message)',
      ...(payload.stack ? { stack: payload.stack } : {}),
    },
    {
      ...(stack ? { componentStack: stack } : {}),
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

/**
 * F9: bundle a crash + adjacent forensics into a single .zip so the
 * user can attach it to a bug report in one click. Contents:
 *   - crash.json                  — the raw crash record
 *   - manifest.json               — app/electron/platform versions,
 *                                   bundle creation ts, scrub mode
 *   - director-messages.json      — last 50 Director messages across
 *                                   all projects (for context — what
 *                                   the user was doing)
 *   - agents.json                 — last 10 agents started in the
 *                                   past 7 days (role, model, status,
 *                                   tokens, cost, started_at)
 *   - logs/<agent-id>.log         — last 200 log lines per agent in
 *                                   that list
 *
 * The opt-in scrubber masks common secret shapes (Anthropic keys,
 * GitHub tokens, AWS access keys, bearer JWTs, generic API-KEY=VALUE
 * env-style assignments). It runs only against strings — JSON
 * numeric fields are passed through unchanged. False-positive
 * redaction in stack traces is preferable to leaking a token.
 */
export function exportCrashBundle(
  crashId: string,
  opts: { scrubSecrets: boolean },
): { ok: true; path: string } | { ok: false; error: string } {
  // Locate the crash JSON. The id is the file basename without extension.
  const dir = crashDir();
  const crashPath = path.join(dir, `${crashId}.json`);
  if (!fs.existsSync(crashPath)) {
    return { ok: false, error: `crash not found: ${crashId}` };
  }
  let crashRaw: string;
  try {
    crashRaw = fs.readFileSync(crashPath, 'utf8');
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'crash read failed',
    };
  }

  const scrub = opts.scrubSecrets ? scrubSecrets : (s: string) => s;

  // Collect forensics from the DB. If the DB is closed (shutdown
  // race / corrupt boot) we still ship the crash JSON alone.
  let directorMessages: unknown[] = [];
  let agents: Array<{ id: string; role: string; model: string; tokens: number; cost: number; status: string; startedAt: number }> = [];
  let logsPerAgent = new Map<string, string>();
  if (isDbOpen()) {
    try {
      directorMessages = readRecentDirectorMessages(50);
    } catch {
      // best-effort
    }
    try {
      agents = readRecentAgents(10);
    } catch {
      // best-effort
    }
    for (const a of agents) {
      try {
        logsPerAgent.set(a.id, readAgentLogTail(a.id, 200));
      } catch {
        // skip this agent
      }
    }
  }

  const manifest = {
    bundleVersion: 1,
    createdAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    scrubSecrets: opts.scrubSecrets,
    crashId,
    counts: {
      directorMessages: directorMessages.length,
      agents: agents.length,
      logsBundled: logsPerAgent.size,
    },
  };

  let zip: AdmZip;
  try {
    zip = new AdmZip();
    zip.addFile(
      'manifest.json',
      Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
    );
    zip.addFile('crash.json', Buffer.from(scrub(crashRaw), 'utf8'));
    zip.addFile(
      'director-messages.json',
      Buffer.from(scrub(JSON.stringify(directorMessages, null, 2)), 'utf8'),
    );
    zip.addFile(
      'agents.json',
      Buffer.from(scrub(JSON.stringify(agents, null, 2)), 'utf8'),
    );
    for (const [agentId, log] of logsPerAgent) {
      zip.addFile(`logs/${agentId}.log`, Buffer.from(scrub(log), 'utf8'));
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'zip build failed',
    };
  }

  const outPath = path.join(dir, `${crashId}-bundle.zip`);
  try {
    zip.writeZip(outPath);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'zip write failed',
    };
  }
  return { ok: true, path: outPath };
}

function readRecentDirectorMessages(limit: number): unknown[] {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const res = db.exec(
    `SELECT id, project_id, who, name, time, body, plan, redirect, prd, created_at
     FROM director_messages
     ORDER BY created_at DESC
     LIMIT ${safeLimit}`,
  );
  if (res.length === 0) return [];
  const out: unknown[] = [];
  for (const row of res[0].values) {
    out.push({
      id: row[0],
      projectId: row[1],
      who: row[2],
      name: row[3],
      time: row[4],
      body: row[5],
      plan: tryJsonParse(row[6]),
      redirect: tryJsonParse(row[7]),
      prd: tryJsonParse(row[8]),
      createdAt: row[9],
    });
  }
  return out.reverse();
}

function readRecentAgents(
  limit: number,
): Array<{
  id: string;
  role: string;
  model: string;
  tokens: number;
  cost: number;
  status: string;
  startedAt: number;
}> {
  const db = getDb();
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const res = db.exec(
    `SELECT id, role, model, tokens, cost, status, started_at
     FROM agents
     WHERE started_at >= ${cutoff}
     ORDER BY started_at DESC
     LIMIT ${Math.max(1, Math.min(limit, 50))}`,
  );
  if (res.length === 0) return [];
  return res[0].values.map((row) => ({
    id: typeof row[0] === 'string' ? row[0] : '',
    role: typeof row[1] === 'string' ? row[1] : '',
    model: typeof row[2] === 'string' ? row[2] : '',
    tokens: typeof row[3] === 'number' ? row[3] : 0,
    cost: typeof row[4] === 'number' ? row[4] : 0,
    status: typeof row[5] === 'string' ? row[5] : '',
    startedAt: typeof row[6] === 'number' ? row[6] : 0,
  }));
}

function readAgentLogTail(agentId: string, limit: number): string {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(limit, 1000));
  const res = db.exec(
    `SELECT ts, kind, msg FROM log_lines
     WHERE agent_id = ?
     ORDER BY seq DESC
     LIMIT ?`,
    [agentId, safeLimit],
  );
  if (res.length === 0) return '';
  const lines: string[] = [];
  for (const row of res[0].values) {
    const ts = typeof row[0] === 'string' ? row[0] : '';
    const kind = typeof row[1] === 'string' ? row[1] : '';
    const msg = typeof row[2] === 'string' ? row[2] : '';
    lines.push(`[${ts}] ${kind}: ${msg}`);
  }
  return lines.reverse().join('\n');
}

function tryJsonParse(v: unknown): unknown {
  if (typeof v !== 'string' || v.length === 0) return null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

// F9's secret-scrubber pass lives in `./secretScrubber` so F11
// run-bundle export shares the same patterns; adding a new
// pattern lights up in both surfaces.

