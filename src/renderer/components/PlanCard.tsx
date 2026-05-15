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
}

export function PlanCard({ rows, accepted }: Props) {
  return (
    <div className="dir-plan">
      <div className="dir-plan-head">
        <span>Plan</span>
        <span
          className="badge"
          style={
            accepted
              ? undefined
              : { background: 'var(--sub-2)', color: 'var(--muted)' }
          }
        >
          {accepted ? 'accepted' : 'spawning…'}
        </span>
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
    </div>
  );
}
