import fs from 'node:fs';
import { app } from 'electron';
import { channelNames, invokeHandler } from './ipc/dispatch';

/**
 * A3: headless stdio JSON-RPC loop. Boots when the process is launched
 * with `--headless` (see index.ts). The controlling process speaks a
 * newline-delimited JSON protocol:
 *
 *   → request   { "id": <any>, "channel": "<ipc channel>", "args": [...] }
 *   ← response  { "type": "response", "id": <same>, "ok": true, "result": ... }
 *               { "type": "response", "id": <same>, "ok": false, "error": "..." }
 *   ← event     { "type": "event", "channel": "<ipc channel>", "payload": ... }
 *   ← ready     { "type": "ready", "channels": ["...", ...] }  (once, on boot)
 *
 * Every captured IPC channel is callable; `args` maps positionally onto
 * the handler's parameters (the same args the renderer passes through
 * `ipcRenderer.invoke`). Broadcast events (agent logs, director
 * messages, etc.) stream out as they happen via the emit sink wired in
 * index.ts. stdin EOF quits the app cleanly.
 *
 * Framing note: only this module and the emit sink write to stdout, and
 * both write exactly one JSON object per line. Nothing in main calls
 * `console.log` on the headless path (the auto-updater, the only
 * stdout-logging module, is skipped), so the stream stays parseable.
 */

interface Request {
  id?: unknown;
  channel?: unknown;
  args?: unknown;
}

function write(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** The emit sink index.ts installs so `broadcast` reaches stdout. */
export function headlessEmit(channel: string, payload: unknown): void {
  write({ type: 'event', channel, payload });
}

// In-flight request bookkeeping. stdin EOF must not quit the process
// while async handlers (DB reads, spawns) are still resolving — a
// piped `cmd | exe --headless` closes stdin immediately after the
// last line, and quitting then would truncate the responses. We only
// quit once stdin has ended AND every dispatched request has settled.
let pending = 0;
let stdinEnded = false;

function maybeQuit(): void {
  if (stdinEnded && pending === 0) app.quit();
}

export function startHeadless(): void {
  // Announce readiness + the callable surface so a consumer can
  // discover channels without a hardcoded list.
  write({ type: 'ready', channels: channelNames() });

  // Read from fd 0 via a freshly-created stream rather than
  // `process.stdin`. On Windows, a packaged Electron app is a
  // GUI-subsystem binary whose `process.stdin` never initialises —
  // it emits no 'data' and (depending on the build) no 'end' either,
  // so the renderer-less process just hangs or quits without ever
  // seeing piped input. `fs.createReadStream(null, { fd: 0 })` opens
  // the inherited stdin handle directly and works under both
  // pipes and file redirection. stdout (`ready`/responses) is
  // unaffected — only the stream layer on fd 0 is the problem.
  const stdin = fs.createReadStream('', { fd: 0, encoding: 'utf8' });
  let buffer = '';
  stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) {
        pending += 1;
        void handleLine(line).finally(() => {
          pending -= 1;
          maybeQuit();
        });
      }
      nl = buffer.indexOf('\n');
    }
  });
  stdin.on('end', () => {
    // Flush a trailing line with no terminating newline.
    const last = buffer.trim();
    if (last.length > 0) {
      pending += 1;
      void handleLine(last).finally(() => {
        pending -= 1;
        maybeQuit();
      });
    }
    stdinEnded = true;
    maybeQuit();
  });
  stdin.on('error', (err) => {
    process.stderr.write(`[headless] stdin error: ${err.message}\n`);
    stdinEnded = true;
    maybeQuit();
  });
}

async function handleLine(line: string): Promise<void> {
  let req: Request;
  try {
    req = JSON.parse(line) as Request;
  } catch {
    write({ type: 'response', id: null, ok: false, error: 'invalid JSON' });
    return;
  }
  const id = req.id ?? null;
  if (typeof req.channel !== 'string') {
    write({
      type: 'response',
      id,
      ok: false,
      error: 'request needs a string "channel"',
    });
    return;
  }
  const args = Array.isArray(req.args) ? req.args : [];
  try {
    const result = await invokeHandler(req.channel, args);
    write({ type: 'response', id, ok: true, result });
  } catch (e) {
    write({
      type: 'response',
      id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
