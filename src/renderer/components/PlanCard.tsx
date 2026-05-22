import { useEffect, useMemo, useState } from 'react';
import type {
  AgentRole,
  DirectorMode,
  PlanCostForecast,
  PlanRow,
} from '../../shared/types';
import { ROLE_TINT } from '../../shared/roles';

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
}

export function PlanCard({
  rows,
  accepted,
  mode,
  onSpawn,
  onSaveAsTemplate,
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

  // F7: pre-spawn cost forecast. Fetches an estimate band whenever the
  // row set changes (or ship-gate toggles, which appends the gate rows
  // to the forecast input). Debounced via the setTimeout in the effect
  // so rapid edits don't fire N IPCs back-to-back.
  const finalRowsForForecast = useMemo<PlanRow[]>(() => {
    const gateRows: PlanRow[] = shipGate
      ? SHIP_GATE_ROWS.map((g, idx) => ({
          ...g,
          i: edited.length + idx + 1,
        }))
      : [];
    return [...edited, ...gateRows];
  }, [edited, shipGate]);
  const [forecast, setForecast] = useState<PlanCostForecast | null>(null);
  useEffect(() => {
    if (accepted || finalRowsForForecast.length === 0) {
      setForecast(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      window.api
        ?.forecastPlanCost(finalRowsForForecast)
        .then((f) => {
          if (!cancelled) setForecast(f);
        })
        .catch(() => {
          if (!cancelled) setForecast(null);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [finalRowsForForecast, accepted]);

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

  return (
    <div className="dir-plan">
      <div className="dir-plan-head">
        <span>Plan</span>
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
            {forecast && edited.length > 0 && (
              <ForecastChip forecast={forecast} />
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
        edited.map((p, i) => (
          <PlanRowView
            key={`${p.name}-${i}`}
            row={p}
            isLast={i === edited.length - 1}
            editable={!accepted}
            onTaskChange={(t) => editTask(i, t)}
            onDrop={() => dropRow(i)}
          />
        ))
      )}
    </div>
  );
}

function ForecastChip({ forecast }: { forecast: PlanCostForecast }) {
  if (forecast.basis === 'no-history') {
    return (
      <span
        className="badge"
        style={{
          height: 18,
          marginLeft: 6,
          padding: '0 6px',
          fontSize: 10,
          background: 'var(--sub-2)',
          color: 'var(--text-2)',
        }}
        title="No history yet for the roles in this plan — the forecast will populate after your first few runs."
      >
        ≈ no history
      </span>
    );
  }
  // The ±50% band is informational; the chip shows a clean range
  // unless the midpoint is so small that the band collapses.
  const fmt = (usd: number): string => {
    if (usd < 0.01) return '<$0.01';
    if (usd < 1) return `$${usd.toFixed(2)}`;
    if (usd < 10) return `$${usd.toFixed(2)}`;
    return `$${usd.toFixed(1)}`;
  };
  const breakdown = forecast.perRole
    .map((p) => {
      const med =
        p.medianUsd > 0
          ? `${fmt(p.medianUsd)}×${p.rowCount}`
          : `no history×${p.rowCount}`;
      return `${p.role}: ${med}`;
    })
    .join('\n');
  return (
    <span
      className="badge"
      style={{
        height: 18,
        marginLeft: 6,
        padding: '0 6px',
        fontSize: 10,
        background: 'var(--sub-2)',
        color: forecast.basis === 'partial' ? 'var(--waiting)' : 'var(--text-2)',
      }}
      title={
        `Forecast based on per-role median cost (±50% band).` +
        (forecast.basis === 'partial'
          ? '\nSome roles have <3 historical runs; estimate uses what we have.'
          : '') +
        `\n\n${breakdown}`
      }
    >
      ≈ {fmt(forecast.lowUsd)}–{fmt(forecast.highUsd)}
    </span>
  );
}

function PlanRowView({
  row,
  isLast,
  editable,
  onTaskChange,
  onDrop,
}: {
  row: PlanRow;
  isLast: boolean;
  editable: boolean;
  onTaskChange: (next: string) => void;
  onDrop: () => void;
}) {
  return (
    <div className="plan-row">
      <span className="num">{String(row.i).padStart(2, '0')}</span>
      <span className="tree">{isLast ? '└─' : '├─'}</span>
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
