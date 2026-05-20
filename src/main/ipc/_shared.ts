import { BrowserWindow, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type { ZodType } from 'zod';
import type { IpcChannel } from '../../shared/ipc';

/**
 * Broadcast a payload to every renderer process. Used for state-change
 * events that any open window should see (DirectorEventMessage,
 * MarketplaceEventSourcesChanged, etc.) — the renderer-side `subscribe`
 * helper in preload/index.ts pairs with this.
 */
export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
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
