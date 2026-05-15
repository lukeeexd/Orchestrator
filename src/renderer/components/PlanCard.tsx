import { useState } from 'react';
import type { AgentRole, PlanRow } from '../../shared/types';

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
  onAccept: (workspace: string) => Promise<void>;
}

export function PlanCard({ rows, accepted, onAccept }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAccept = async () => {
    setError(null);
    const { path } = await window.api.pickWorkspace();
    if (!path) return;
    setBusy(true);
    try {
      await onAccept(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dir-plan">
      <div className="dir-plan-head">
        <span>Plan</span>
        {accepted ? (
          <span className="badge">accepted</span>
        ) : (
          <button
            className="tb-btn primary"
            style={{ height: 22, marginLeft: 'auto' }}
            disabled={busy}
            onClick={handleAccept}
          >
            {busy ? 'Spawning…' : 'Accept & spawn'}
          </button>
        )}
      </div>
      {rows.map((p, i) => (
        <div className="plan-row" key={`${p.name}-${i}`}>
          <span className="num">{String(p.i).padStart(2, '0')}</span>
          <span className="tree">{i === rows.length - 1 ? '└─' : '├─'}</span>
          <span className="who" style={{ color: ROLE_TINT[p.role] }}>
            {p.role}
          </span>
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {p.task}
          </span>
        </div>
      ))}
      {error && (
        <div className="form-error" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}
    </div>
  );
}
