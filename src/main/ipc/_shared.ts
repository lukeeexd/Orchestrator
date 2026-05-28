import { BrowserWindow, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type { ZodType } from 'zod';
import type { IpcChannel } from '../../shared/ipc';

type EmitSink = (channel: string, payload: unknown) => void;

/**
 * Default emit sink: fan a payload out to every renderer process via
 * `webContents.send`. This is the GUI transport.
 */
const browserWindowSink: EmitSink = (channel, payload) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
};

let emitSink: EmitSink = browserWindowSink;

/**
 * A3 (headless): swap the transport that `broadcast` writes through.
 * GUI mode leaves the default (renderer fan-out); headless mode points
 * it at stdout so state-change events stream to the controlling
 * process. Passing null restores the default.
 */
export function setEmitSink(sink: EmitSink | null): void {
  emitSink = sink ?? browserWindowSink;
}

/**
 * Broadcast a payload for state-change events any consumer should see
 * (DirectorEventMessage, MarketplaceEventSourcesChanged, etc.). In GUI
 * mode the renderer-side `subscribe` helper in preload/index.ts pairs
 * with this; in headless mode it streams to stdout.
 */
export function broadcast(channel: string, payload: unknown): void {
  emitSink(channel, payload);
}

/**
 * Shared context every domain register-handler receives. Lets a handler
 * push events back to the renderer without each domain re-declaring its
 * own broadcast helper.
 *
 * Extending the context (e.g. a session id, a feature flag) means adding
 * a field here rather than threading args through every register call.
 */
export interface IpcContext {
  broadcast: typeof broadcast;
}

/**
 * Register a handler whose payload must match a runtime schema. The
 * handler signature mirrors `ipcMain.handle` minus the unknown-typed
 * payload — by the time the handler runs, the payload is already typed
 * and validated.
 *
 * When the payload doesn't match, the IPC promise rejects with a
 * descriptive error: the renderer's catch already handles rejected IPC
 * calls (it surfaces as `error?: string` in the response or a thrown
 * exception, depending on the call shape).
 *
 * Only used for the high-value channels — multi-arg channels like
 * `(id, value)` keep `ipcMain.handle` directly since TypeScript narrows
 * those at the call site already.
 */
export function validated<T, R>(
  channel: IpcChannel,
  schema: ZodType<T>,
  handler: (event: IpcMainInvokeEvent, payload: T) => R | Promise<R>,
): void {
  ipcMain.handle(channel, async (event, raw: unknown): Promise<R> => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      // Surface enough detail for the renderer's devtools to be useful
      // without leaking the full Zod issue tree (which can include
      // user-supplied data via the path field).
      const first = parsed.error.issues[0];
      const detail = first
        ? `${first.path.join('.') || '<root>'}: ${first.message}`
        : 'unknown';
      throw new Error(`IPC payload invalid (${channel}) — ${detail}`);
    }
    return handler(event, parsed.data);
  });
}
