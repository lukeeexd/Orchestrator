import { Icon } from './Icon';

interface Props {
  busy: boolean;
  /** Spawn the built-in onboarding template via window.api.useTemplate. */
  onRun: () => void;
  /** Mark this project's banner as dismissed (persists in localStorage). */
  onSkip: () => void;
}

/**
 * P2 — codebase onboarding nudge. Shown at the top of the agents pane
 * when the active project's workspace doesn't yet have a WORKSPACE.md
 * AND the user hasn't previously dismissed the banner for this project.
 *
 * "Run onboarding" → calls window.api.useTemplate with the built-in
 * `builtin-codebase-onboarding` template id. That synthesises a
 * Director chat message carrying the researcher row, which the
 * PlanCard then handles like any other plan — the user can edit the
 * task before accepting if they want.
 *
 * "Skip" → sets a localStorage flag scoped to the project so the
 * banner stays gone until the user explicitly resets it. The next
 * successful onboarding run will also drop the banner naturally
 * (WORKSPACE.md exists post-run).
 */
export function OnboardingBanner({ busy, onRun, onSkip }: Props) {
  return (
    <div
      style={{
        margin: '8px 12px',
        padding: '10px 12px',
        background: 'var(--sub-1)',
        border: '1px solid var(--border)',
        borderLeft: '3px solid var(--accent)',
        borderRadius: 4,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <Icon name="templates" size={14} color="var(--accent)" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
          Onboard this workspace?
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-2)',
            lineHeight: 1.4,
            marginTop: 2,
          }}
        >
          A researcher will walk the project and produce{' '}
          <code>WORKSPACE.md</code> at the root — top-level layout, build /
          test commands, primary entry points, notable conventions. The
          Director picks it up as context on subsequent turns.
        </div>
      </div>
      <button
        className="tb-btn"
        onClick={onSkip}
        disabled={busy}
        title="Skip — this banner stays gone for this project until you reset it"
        style={{ height: 24 }}
      >
        Skip
      </button>
      <button
        className="tb-btn primary"
        onClick={onRun}
        disabled={busy}
        title="Spawn the onboarding researcher (built-in template)"
        style={{ height: 24 }}
      >
        {busy ? 'Spawning…' : 'Run onboarding'}
      </button>
    </div>
  );
}
