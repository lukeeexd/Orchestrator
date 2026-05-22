import { Component, type ErrorInfo, type ReactNode } from 'react';
import { markCrashHandled } from '../crashListeners';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

/**
 * S5: React error boundary that catches renderer-side throws,
 * forwards a structured record to the main process via the
 * `recordRendererCrash` IPC, and renders a minimal fallback so the
 * user sees something other than a white screen.
 *
 * The renderer reload button is intentionally simple: re-mount via
 * `location.reload()`. We don't try to be clever about recovering
 * in-place because the React tree is already in an unknown state by
 * the time we get here — a clean reload re-hydrates state from the
 * main-side DB.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    // R-A4: mark this error so the global window.error listener
    // doesn't write a duplicate crash record when the same throw
    // bubbles up. React 19 lets sync throws hit both paths.
    markCrashHandled(error);
    void window.api
      ?.recordRendererCrash({
        name: error.name,
        message: error.message,
        ...(error.stack ? { stack: error.stack } : {}),
        ...(info.componentStack ? { componentStack: info.componentStack } : {}),
        ...(typeof window !== 'undefined' && window.location
          ? { url: window.location.href }
          : {}),
      })
      .catch(() => {
        // Best-effort. If the IPC bridge itself is broken we can't do
        // much from here; stderr in main already has the original
        // throw if the preload bridge made it that far.
      });
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="error-boundary">
        <div className="error-boundary-card">
          <h2>Something went wrong</h2>
          <p className="error-boundary-msg">
            The Orchestrator UI hit an unexpected error and stopped
            rendering. The crash has been saved to <code>userData/crashes/</code>{' '}
            for diagnostics.
          </p>
          <pre className="error-boundary-stack">
            {this.state.error.name}: {this.state.error.message}
            {this.state.error.stack ? `\n\n${this.state.error.stack}` : ''}
          </pre>
          <div className="error-boundary-actions">
            <button
              className="tb-btn primary"
              onClick={() => window.location.reload()}
            >
              Reload window
            </button>
            <button
              className="tb-btn"
              onClick={() => void window.api?.openCrashesFolder()}
            >
              Open crashes folder
            </button>
          </div>
        </div>
      </div>
    );
  }
}
