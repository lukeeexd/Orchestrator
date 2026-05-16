import { useEffect, useState } from 'react';
import type { AgentRole, DirectorMode, PlanRow } from '../../shared/types';

const ROLE_TINT: Record<AgentRole, string> = {
  pm: '#4ade80',
  researcher: '#60a5fa',
  coder: '#c084fc',
  qa: '#fbbf24',
  devops: '#f97316',
};

interface Props {
  rows: PlanRow[];
  accepted: boolean;
  mode: DirectorMode;
  /** Receives the (possibly edited) rows the user actually wants to spawn. */
  onSpawn: (rows: PlanRow[]) => Promise<void>;
}

export function PlanCard({ rows, accepted, mode, onSpawn }: Props) {
  // Local editable copy of the plan. The Director's original proposal
  // stays on the message; this state is what the user can prune/tweak
  // before clicking Spawn. Resync if the upstream rows change (e.g. a
  // late-arriving streaming update).
  const [edited, setEdited] = useState<PlanRow[]>(rows);
  useEffect(() => {
    if (!accepted) setEdited(rows);
  }, [rows, accepted]);

  const [busy, setBusy] = useState(false);

  const handleSpawn = async () => {
    if (edited.length === 0) return;
    setBusy(true);
    try {
      await onSpawn(edited);
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
            <button
              className="tb-btn primary"
              style={{
                height: 20,
                marginLeft: dirty ? 6 : 'auto',
              }}
              disabled={busy || edited.length === 0}
              onClick={handleSpawn}
              title={
                edited.length === 0
                  ? 'No rows left — add some back or send a new task'
                  : mode === 'auto'
                  ? 'Spawn the fleet — Director will continue to orchestrate'
                  : 'Spawn the fleet'
              }
            >
              {busy
                ? 'Spawning…'
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
