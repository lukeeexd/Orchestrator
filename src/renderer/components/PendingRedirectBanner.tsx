import { useEffect, useState } from 'react';
import { Icon } from './Icon';

interface Props {
  /** Director-emitted target agent (display name, e.g. "coder-01"). */
  agentName: string;
  /** The instruction body the Director wants to send to the agent. */
  instruction: string;
  /** Epoch-ms timestamp at which the redirect will auto-fire. */
  firesAt: number;
  /** User pressed Cancel — caller clears the timer and acks the redirect as cancelled. */
  onCancel: () => void;
}

/**
 * R-Vuln6-2026-05-28: in auto mode the Director's `orchestrator-redirect`
 * block previously fired the instant it appeared, with no user-visible
 * window to intervene. The instruction body is interpolated raw into the
 * resumed worker's prompt (`Continuing task. New instruction:\n${body}`)
 * and workers run with `--permission-mode bypassPermissions`. Combined
 * with any upstream prompt-injection vector that steers Director output
 * (marketplace skill meta — see R-Vuln5 — user-pasted content, attached
 * file contents), the auto-fire path is a one-step amplifier from
 * "Director context contains attacker text" to "worker runs that text".
 *
 * This banner adds a visible cancel window: when the auto-fire effect
 * picks up an unfired redirect, it stages it here for a few seconds
 * with a Cancel button before actually firing. Three seconds is enough
 * to react if the user is looking; if they're not, the redirect still
 * fires (the auto-mode convenience is preserved) but the audit trail
 * in the chat shows what went out either way.
 */
export function PendingRedirectBanner({
  agentName,
  instruction,
  firesAt,
  onCancel,
}: Props) {
  // Local ticker — recomputes the remaining seconds for the countdown.
  // 200ms cadence keeps the digit lively without burning render budget.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, []);
  const remainingMs = Math.max(0, firesAt - now);
  const remainingSec = Math.ceil(remainingMs / 1000);

  // Truncate the instruction preview — full body is in the chat already.
  const preview =
    instruction.length > 120 ? instruction.slice(0, 117) + '…' : instruction;

  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        position: 'fixed',
        bottom: 32,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 50,
        background: 'var(--sub-1)',
        border: '1px solid var(--border)',
        borderLeft: '3px solid var(--warn, var(--accent))',
        borderRadius: 4,
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.35)',
        padding: '10px 14px',
        minWidth: 380,
        maxWidth: 560,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <Icon name="redirect" size={14} color="var(--accent)" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span>
            Auto-firing redirect to{' '}
            <span style={{ color: 'var(--accent)' }}>@{agentName}</span> in{' '}
            {remainingSec}s
          </span>
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-2)',
            lineHeight: 1.4,
            marginTop: 2,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          title={instruction}
        >
          {preview}
        </div>
      </div>
      <button
        className="tb-btn"
        onClick={onCancel}
        style={{ height: 24 }}
        title="Cancel this auto-redirect — the agent will not be resumed"
      >
        Cancel
      </button>
    </div>
  );
}
