/**
 * S5 follow-up: global renderer crash listeners.
 *
 * The React ErrorBoundary only catches errors thrown during React's
 * render/commit phases. It does NOT catch:
 *   - synchronous throws from the DevTools console REPL
 *   - errors thrown inside setTimeout / setInterval / event handlers
 *     that don't unwind through React
 *   - unhandled promise rejections
 *
 * `window.addEventListener('error', ...)` + `'unhandledrejection'`
 * catch all three, and we forward them to the same main-side IPC
 * pipeline that records boundary catches.
 *
 * R-A4 dedup: React 19 lets a sync throw inside a lifecycle hit the
 * ErrorBoundary AND bubble to `window.error`. Without the WeakSet
 * below, every boundary catch records two crashes. The boundary
 * calls `markCrashHandled(err)` before forwarding; this listener
 * checks the set and skips duplicates.
 */

let installed = false;
const handledErrors = new WeakSet<object>();

/** Called by the ErrorBoundary to short-circuit the global listener. */
export function markCrashHandled(err: unknown): void {
  if (err && typeof err === 'object') {
    handledErrors.add(err);
  }
}

export function installRendererCrashListeners(): void {
  if (installed) return;
  installed = true;

  window.addEventListener('error', (ev: ErrorEvent) => {
    // Some events carry only `message` (e.g. cross-origin script
    // errors). Coerce whatever we have into the same shape main
    // expects.
    const err = ev.error;
    if (err && typeof err === 'object' && handledErrors.has(err)) {
      // ErrorBoundary already captured this throw — don't double-record.
      return;
    }
    const payload =
      err instanceof Error
        ? {
            name: err.name,
            message: err.message,
            ...(err.stack ? { stack: err.stack } : {}),
          }
        : {
            name: 'WindowError',
            message: ev.message || '(no message)',
          };
    void window.api?.recordRendererCrash({
      ...payload,
      url: window.location.href,
    });
  });

  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    const reason = ev.reason;
    const payload =
      reason instanceof Error
        ? {
            name: reason.name,
            message: reason.message,
            ...(reason.stack ? { stack: reason.stack } : {}),
          }
        : {
            name: 'UnhandledRejection',
            message:
              typeof reason === 'string' ? reason : JSON.stringify(reason),
          };
    void window.api?.recordRendererCrash({
      ...payload,
      url: window.location.href,
    });
  });
}
