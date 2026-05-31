import type { RunLedger, LedgerRow, TestsRunSummary } from '../../shared/types';
import { ROLE_TINT } from '../../shared/roles';

/**
 * N5 — live Task/Progress ledger for an accepted-plan run. Rides on the plan's
 * DirectorMessage (`message.ledger`) and re-renders as the accept loop patches
 * row status + evidence in. Mirrors PlanCard's framing (`dir-plan` /
 * `plan-row`) so the two cards read as a pair under one plan; everything else
 * is inline-styled on the shared theme tokens (light + dark) like N7/N9.
 *
 * Surface-only: when the run stalls (two consecutive no-progress steps) the
 * accept loop pauses spawning and sets `stalled` — the card shows an amber
 * banner. No auto-replan (deferred, gated on a session-wide budget cap).
 */

const STATUS_GLYPH: Record<
  LedgerRow['status'],
  { sym: string; color: string; label: string }
> = {
  pending: { sym: '○', color: 'var(--text-2)', label: 'pending' },
  active: { sym: '◐', color: 'var(--accent)', label: 'running' },
  done: { sym: '✓', color: 'var(--ok, #4ade80)', label: 'done' },
  failed: { sym: '✗', color: 'var(--error, #f87171)', label: 'failed — agent errored or was aborted' },
};

const chipStyle: React.CSSProperties = {
  fontSize: 10,
  fontFamily: 'var(--font-mono, monospace)',
  color: 'var(--text-2)',
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

function testsTitle(t: TestsRunSummary): string {
  return `tests — ${t.pass} passed, ${t.fail} failed, ${t.skip} skipped`;
}

export function LedgerCard({ ledger }: { ledger: RunLedger }) {
  const total = ledger.rows.length;
  const doneCount = ledger.rows.filter((r) => r.status === 'done').length;

  return (
    <div className="dir-plan">
      <div className="dir-plan-head">
        <span>Progress</span>
        <span
          className="badge"
          style={{
            background: 'var(--sub-2)',
            color: 'var(--text-2)',
            fontSize: 10,
            marginLeft: 6,
          }}
          title="Rows completed in this run"
        >
          {doneCount}/{total} done
        </span>
        {ledger.stalled && (
          <span
            className="badge"
            style={{
              background: 'var(--sub-2)',
              color: 'var(--waiting)',
              fontSize: 10,
              marginLeft: 'auto',
            }}
            title="Two consecutive steps made no measurable progress — the run was paused for review."
          >
            ⚠ paused
          </span>
        )}
        {ledger.capped && (
          <span
            className="badge"
            style={{
              background: 'var(--sub-2)',
              color: 'var(--waiting)',
              fontSize: 10,
              marginLeft: ledger.stalled ? 6 : 'auto',
            }}
            title="The run hit its spawn cap (Settings → Max agents per run) and stopped to avoid a runaway loop."
          >
            ⚠ capped
          </span>
        )}
      </div>
      {ledger.rows.map((r, i) => (
        <LedgerRowView key={`${r.name}-${i}`} row={r} isLast={i === total - 1} />
      ))}
      {ledger.stalled && ledger.pausedReason && (
        <div
          style={{
            padding: '6px 12px 8px',
            fontSize: 11,
            color: 'var(--waiting)',
            borderTop: '1px dashed var(--sub-2)',
            marginTop: 4,
            display: 'flex',
            gap: 6,
            alignItems: 'baseline',
          }}
        >
          <span style={{ fontWeight: 700 }}>⚠</span>
          <span>{ledger.pausedReason}</span>
        </div>
      )}
      {ledger.capped && ledger.cappedReason && (
        <div
          style={{
            padding: '6px 12px 8px',
            fontSize: 11,
            color: 'var(--waiting)',
            borderTop: '1px dashed var(--sub-2)',
            marginTop: 4,
            display: 'flex',
            gap: 6,
            alignItems: 'baseline',
          }}
        >
          <span style={{ fontWeight: 700 }}>⚠</span>
          <span>{ledger.cappedReason}</span>
        </div>
      )}
    </div>
  );
}

function LedgerRowView({ row, isLast }: { row: LedgerRow; isLast: boolean }) {
  const g = STATUS_GLYPH[row.status];
  const ev = row.evidence;
  return (
    <div className="plan-row">
      <span className="num">{String(row.i).padStart(2, '0')}</span>
      <span className="tree">{isLast ? '└─' : '├─'}</span>
      <span
        title={g.label}
        style={{
          color: g.color,
          fontFamily: 'var(--font-mono, monospace)',
          fontWeight: 700,
          marginRight: 2,
        }}
      >
        {g.sym}
      </span>
      <span className="who" style={{ color: ROLE_TINT[row.role] }}>
        {row.role}
      </span>
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
          minWidth: 0,
        }}
        title={ev?.summary || row.task}
      >
        {row.task}
      </span>
      {ev && (
        <span
          style={{ display: 'inline-flex', gap: 8, alignItems: 'baseline', marginLeft: 8 }}
        >
          <span style={chipStyle} title={`${ev.filesTouched} file(s) written`}>
            {ev.filesTouched}f
          </span>
          {ev.testsRun && ev.testsRun.pass + ev.testsRun.fail > 0 && (
            <span style={{ ...chipStyle }} title={testsTitle(ev.testsRun)}>
              <span style={{ color: 'var(--ok, #4ade80)' }}>✓{ev.testsRun.pass}</span>
              {ev.testsRun.fail > 0 && (
                <span style={{ color: 'var(--error, #f87171)' }}>
                  {' '}
                  ✗{ev.testsRun.fail}
                </span>
              )}
            </span>
          )}
          {ev.errors > 0 && (
            <span
              style={{ ...chipStyle, color: 'var(--error, #f87171)' }}
              title={`${ev.errors} error(s) logged`}
            >
              {ev.errors} err
            </span>
          )}
        </span>
      )}
    </div>
  );
}
