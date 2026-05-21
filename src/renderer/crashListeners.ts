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
 */

let installed = false;

export function installRendererCrashListeners(): void {
  if (installed) return;
  installed = true;

  window.addEventListener('error', (ev: ErrorEvent) => {
    // Some events carry only `message` (e.g. cross-origin script
    // errors). Coerce whatever we have into the same shape main
    // expects.
    const err = ev.error;
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
