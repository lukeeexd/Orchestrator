import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

/**
 * A3 (headless): a registry of every IPC handler keyed by channel.
 *
 * The renderer reaches handlers through Electron's `ipcMain.handle`
 * machinery. Headless mode has no renderer, so it needs a second way
 * to reach the *same* handlers — without rewriting all ~90 call sites
 * to route through a custom dispatcher.
 *
 * The trick: temporarily wrap `ipcMain.handle` while
 * `registerIpcHandlers` runs, so every handler a domain registers is
 * also recorded here. We still call through to the real `ipcMain.handle`
 * so GUI behaviour is byte-for-byte unchanged. After registration the
 * original is restored. The wrap is confined to one function with a
 * try/finally restore — no global mutation outlives `captureHandlers`.
 */

type Handler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown | Promise<unknown>;

const handlers = new Map<string, Handler>();

/**
 * Run `register` with `ipcMain.handle` wrapped so each
 * `(channel, handler)` pair is recorded into our map in addition to
 * being registered with Electron. Restores the original afterward.
 */
export function captureHandlers(register: () => void): void {
  const original = ipcMain.handle.bind(ipcMain);
  // The cast mirrors Electron's overloaded signature; we only care
  // about the (channel, listener) form every call site uses.
  ipcMain.handle = ((channel: string, listener: Handler) => {
    handlers.set(channel, listener);
    return original(channel, listener as Parameters<typeof original>[1]);
  }) as typeof ipcMain.handle;
  try {
    register();
  } finally {
    ipcMain.handle = original;
  }
}

/**
 * Invoke a captured handler by channel name with a positional arg
 * list. Headless has no real `IpcMainInvokeEvent`, so we pass a stub —
 * none of the scriptable handlers read `event.sender` / `event.frameId`
 * (they broadcast through the shared sink instead). Throws on an
 * unknown channel so the caller can return a clean protocol error.
 */
export async function invokeHandler(
  channel: string,
  args: unknown[],
): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`unknown channel: ${channel}`);
  const stubEvent = {} as IpcMainInvokeEvent;
  return await fn(stubEvent, ...args);
}

/** Sorted list of every channel a handler was registered for. */
export function channelNames(): string[] {
  return [...handlers.keys()].sort();
}
