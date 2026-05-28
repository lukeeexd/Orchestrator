import { useEffect, useMemo, useState } from 'react';
import type {
  DirectorMode,
  PlanRow,
} from '../../shared/types';
import { ROLE_TINT } from '../../shared/roles';
import { diffPlans, type PlanRowDiffStatus } from '../lib/planDiff';

const SHIP_GATE_LS_KEY = 'orchestrator.shipGate';

/**
 * Synthetic qa + security rows appended to a plan when Ship Gate is on.
 * Hardcoded prompts — the user can edit them inline like any other row
 * before clicking Spawn, and they go through the runner's normal
 * sequential-spawn path. If either fails, the existing per-row failure
 * handling in DirectorAcceptPlan stops the sequence and pushes a
 * system message; no separate "gate failed" plumbing needed.
 */
const SHIP_GATE_ROWS: ReadonlyArray<Pick<PlanRow, 'role' | 'name' | 'task'>> = [
  {
    role: 'qa',
    name: 'gate-qa',
    task: 'Run the test suite and exercise the changes from the previous rows against the golden path + one edge case. Report pass/fail counts and any regressions.',
  },
  {
    role: 'security',
    name: 'gate-security',
    task: 'Audit the changes from the previous rows for hardcoded secrets, unsafe shell/SQL patterns, missing input validation at trust boundaries, and any new dependencies with known CVEs. Report findings ranked by severity.',
  },
];

interface Props {
  rows: PlanRow[];
  accepted: boolean;
  mode: DirectorMode;
  /** Receives the (possibly edited) rows the user actually wants to spawn. */
  onSpawn: (rows: PlanRow[]) => Promise<void>;
  /**
   * Optional capture-as-template hook. The PlanCard exposes a small
   * "Save" button next to Spawn when this is provided; the parent
   * handles the actual dialog + IPC. Receives the *currently edited*
   * row set so the saved template matches what the user sees.
   */
  onSaveAsTemplate?: (rows: PlanRow[]) => void;
  /**
   * F2: when this card replaces an earlier plan in the same Director
   * conversation, the rows of the previous plan. The parent walks
   * `messages` backward to find the most recent prior plan-bearing
   * message and passes its rows here. Undefined for the first plan
   * in a conversation or when no prior plan exists.
   */
  prevRows?: PlanRow[];
}

export function PlanCard({
  rows,
  accepted,
  mode,
  onSpawn,
  onSaveAsTemplate,
  prevRows,
}: Props) {
  // Local editable copy of the plan. The Director's original proposal
  // stays on the message; this state is what the user can prune/tweak
  // before clicking Spawn. Resync if the upstream rows change (e.g. a
  // late-arriving streaming update).
  const [edited, setEdited] = useState<PlanRow[]>(rows);
  useEffect(() => {
    if (!accepted) setEdited(rows);
  }, [rows, accepted]);

  const [busy, setBusy] = useState(false);
  // Ship Gate toggle — when on, the Spawn click appends a qa + security
  // pass to the plan so the user can't accidentally land a feature
  // without verification. Persisted globally (not per-project) so the
  // intent travels with the user.
  const [shipGate, setShipGate] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SHIP_GATE_LS_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SHIP_GATE_LS_KEY, shipGate ? '1' : '0');
    } catch {
      /* private window / quota / etc — best-effort persistence */
    }
  }, [shipGate]);

  const handleSpawn = async () => {
    if (edited.length === 0) return;
    setBusy(true);
    try {
      // Build the final row list. When the gate is on, append synthetic
      // qa + security rows; renumber `i` so PlanCard's 00/01/02 numbering
      // stays sequential. The user already saw the final list when they
      // ticked the gate — no extra confirmation here.
      const gateRows: PlanRow[] = shipGate
        ? SHIP_GATE_ROWS.map((g, idx) => ({
            ...g,
            i: edited.length + idx + 1,
          }))
        : [];
      const finalRows = [...edited, ...gateRows];
      await onSpawn(finalRows);
    } finally {
      setBusy(false);
    }
  };

  const dropRow = (idx: number) => {
    setEdited((prev) => prev.filter((_, i) => i !== idx));
  };

  const editTask = (idx: number, task: string) => {
    setEdited((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, task } : r)),
    );
  };

  const dirty =
    edited.length !== rows.length ||
    edited.some((r, i) => r.task !== rows[i]?.task);

  // F2: diff against the previous plan (if any). The diff is computed
  // against the Director's emitted `rows`, not the user-edited `edited`
  // set — we want to surface what the Director changed, not what the
  // user just unticked. Keyed by (role, name) — see planDiff.ts for
  // match semantics.
  const planDiff = useMemo(
    () => (prevRows && prevRows.length > 0 ? diffPlans(rows, prevRows) : null),
    [rows, prevRows],
  );
  const diffByRow = useMemo(() => {
    const m = new Map<string, { status: PlanRowDiffStatus; prevTask?: string }>();
    if (!planDiff) return m;
    for (const r of planDiff.rows) {
      m.set(`${r.row.role}\x00${r.row.name}`, {
        status: r.status,
        ...(r.prevTask !== undefined ? { prevTask: r.prevTask } : {}),
      });
    }
    return m;
  }, [planDiff]);
  const hasMeaningfulDiff =
    planDiff !== null &&
    (planDiff.summary.added > 0 ||
      planDiff.summary.modified > 0 ||
      planDiff.summary.removed > 0);

  return (
    <div className="dir-plan">
      <div className="dir-plan-head">
        <span>Plan</span>
        {hasMeaningfulDiff && planDiff && (
          <span
            className="badge"
            style={{
              background: 'var(--sub-2)',
              color: 'var(--text-2)',
              fontSize: 10,
              marginLeft: 6,
            }}
            title={
              `Changed since the previous plan:` +
              `\n  +${planDiff.summary.added} added` +
              `\n  ~${planDiff.summary.modified} modified` +
              `\n  -${planDiff.summary.removed} removed` +
              (planDiff.summary.unchanged > 0
                ? `\n  ${planDiff.summary.unchanged} unchanged`
                : '')
            }
          >
            <span style={{ color: 'var(--ok, #4ade80)' }}>
              +{planDiff.summary.added}
            </span>
            {' / '}
            <span style={{ color: 'var(--waiting, #fbbf24)' }}>
              ~{planDiff.summary.modified}
            </span>
            {' / '}
            <span style={{ color: 'var(--error, #f87171)' }}>
              -{planDiff.summary.removed}
            </span>
          </span>
        )}
        {accepted ? (
          <span className="badge">accepted</span>
        ) : (
          <>
            {dirty && (
              <span
                className="badge"
                style={{
                  background: 'var(--sub-2)',
                  color: 'var(--waiting)',
                  marginLeft: 'auto',
                }}
              >
                edited
              </span>
            )}
            <label
              style={{
                marginLeft: dirty ? 6 : 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11,
                color: shipGate ? 'var(--accent)' : 'var(--text-2)',
                cursor: 'pointer',
                userSelect: 'none',
              }}
              title="Append a qa + security pass after the plan. The gates must complete without error before the Director considers the plan done."
            >
              <input
                type="checkbox"
                checked={shipGate}
                onChange={(e) => setShipGate(e.target.checked)}
                style={{ margin: 0 }}
                disabled={busy}
              />
              ship gate
            </label>
            {onSaveAsTemplate && edited.length > 0 && (
              <button
                className="tb-btn"
                style={{ height: 20, marginLeft: 6 }}
                disabled={busy}
                onClick={() => onSaveAsTemplate(edited)}
                title="Save these rows as a reusable template"
              >
                Save as template
              </button>
            )}
            <button
              className="tb-btn primary"
              style={{ height: 20, marginLeft: 6 }}
              disabled={busy || edited.length === 0}
              onClick={handleSpawn}
              title={
                edited.length === 0
                  ? 'No rows left — add some back or send a new task'
                  : shipGate
                  ? `Spawn ${edited.length} + 2 gate agents (qa, security)`
                  : mode === 'auto'
                  ? 'Spawn the fleet — Director will continue to orchestrate'
                  : 'Spawn the fleet'
              }
            >
              {busy
                ? 'Spawning…'
                : shipGate
                ? `Spawn ${edited.length} + 2`
                : `Spawn ${edited.length}${edited.length === 1 ? ' agent' : ' agents'}`}
            </button>
          </>
        )}
      </div>
      {edited.length === 0 ? (
        <div
          className="inline-empty"
          style={{ padding: '8px 12px', fontSize: 11 }}
        >
          No rows — every agent was removed. Send a new task to get a fresh
          plan.
        </div>
      ) : (
        edited.map((p, i) => {
          const diff = diffByRow.get(`${p.role}\x00${p.name}`);
          return (
            <PlanRowView
              key={`${p.name}-${i}`}
              row={p}
              isLast={i === edited.length - 1}
              editable={!accepted}
              onTaskChange={(t) => editTask(i, t)}
              onDrop={() => dropRow(i)}
              diffStatus={diff?.status}
              prevTask={diff?.prevTask}
            />
          );
        })
      )}
      {planDiff && planDiff.removed.length > 0 && (
        <div
          style={{
            padding: '4px 12px 8px',
            fontSize: 10,
            color: 'var(--text-2)',
            borderTop: '1px dashed var(--sub-2)',
            marginTop: 4,
          }}
          title="These rows were in the previous plan but the Director dropped them in this revision."
        >
          <span style={{ color: 'var(--error, #f87171)' }}>− removed:</span>{' '}
          {planDiff.removed.map((r, i) => (
            <span key={`${r.role}-${r.name}-${i}`}>
              {i > 0 && ', '}
              <span style={{ color: ROLE_TINT[r.role] }}>{r.role}</span>{' '}
              <span style={{ textDecoration: 'line-through' }}>{r.name}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function PlanRowView({
  row,
  isLast,
  editable,
  onTaskChange,
  onDrop,
  diffStatus,
  prevTask,
}: {
  row: PlanRow;
  isLast: boolean;
  editable: boolean;
  onTaskChange: (next: string) => void;
  onDrop: () => void;
  diffStatus?: PlanRowDiffStatus;
  prevTask?: string;
}) {
  // F2: per-row diff marker. A coloured leading glyph + a tooltip on
  // the role label that surfaces the previous task text when modified.
  const diffGlyph =
    diffStatus === 'added'
      ? { sym: '+', color: 'var(--ok, #4ade80)', tip: 'New in this plan' }
      : diffStatus === 'modified'
        ? {
            sym: '~',
            color: 'var(--waiting, #fbbf24)',
            tip: prevTask
              ? `Task changed from previous plan:\n  was: ${prevTask}`
              : 'Task changed from previous plan',
          }
        : null;
  return (
    <div className="plan-row">
      <span className="num">{String(row.i).padStart(2, '0')}</span>
      <span className="tree">{isLast ? '└─' : '├─'}</span>
      {diffGlyph && (
        <span
          style={{
            color: diffGlyph.color,
            fontFamily: 'var(--font-mono, monospace)',
            fontWeight: 700,
            marginRight: 2,
          }}
          title={diffGlyph.tip}
        >
          {diffGlyph.sym}
        </span>
      )}
      <span className="who" style={{ color: ROLE_TINT[row.role] }}>
        {row.role}
      </span>
      {editable ? (
        <>
          <input
            className="text-input"
            value={row.task}
            onChange={(e) => onTaskChange(e.target.value)}
            style={{
              flex: 1,
              minWidth: 0,
              height: 20,
              padding: '2px 6px',
              fontSize: 11,
            }}
          />
          <button
            className="icon-btn"
            onClick={onDrop}
            title="Drop this agent from the plan"
            style={{ width: 18, height: 18, fontSize: 12, lineHeight: '14px' }}
          >
            ×
          </button>
        </>
      ) : (
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {row.task}
        </span>
      )}
    </div>
  );
}
