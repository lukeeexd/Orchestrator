import { useEffect, useState } from 'react';
import type {
  AgentRole,
  SpendAgentRow,
  SpendBucket,
  SpendSummary,
} from '../../shared/types';
import { Icon } from './Icon';

const ROLE_TINT: Record<AgentRole, string> = {
  pm: '#4ade80',
  researcher: '#60a5fa',
  coder: '#c084fc',
  qa: '#fbbf24',
  devops: '#f97316',
};

const STATUS_TINT: Record<string, string> = {
  done: 'var(--accent)',
  error: 'var(--error)',
  running: 'var(--accent)',
  waiting: 'var(--waiting)',
  aborted: 'var(--muted)',
  paused: 'var(--muted)',
};

function fmt$(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

function fmtRelTime(ts: number): string {
  const diff = Date.now() - ts;
  const day = 24 * 3600 * 1000;
  if (diff < 3600_000) return `${Math.max(1, Math.floor(diff / 60_000))}m ago`;
  if (diff < day) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function SpendScreen() {
  const [data, setData] = useState<SpendSummary | null>(null);
  const [reloading, setReloading] = useState(false);

  const load = async () => {
    setReloading(true);
    try {
      const next = await window.api.getSpendSummary();
      setData(next);
    } finally {
      setReloading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (!data) {
    return (
      <div className="pane settings-pane" style={{ flex: 1 }}>
        <div className="pane-head">
          <span className="title">
            <b>Spend</b>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="pane settings-pane" style={{ flex: 1 }}>
      <div className="pane-head">
        <span className="title">
          <b>Spend</b>
        </span>
        <span className="spacer" />
        <button
          className="tb-btn"
          onClick={() => void load()}
          disabled={reloading}
          title="Recompute aggregates from the database"
        >
          <Icon name="redirect" size={11} /> {reloading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div className="settings-body">
        <section className="settings-section">
          <h3 className="settings-h">Totals</h3>
          <div className="spend-kpis">
            <SpendKpi
              label="Last 7 days"
              cost={data.last7d.cost}
              agentCount={data.last7d.agentCount}
              tokens={data.last7d.tokens}
            />
            <SpendKpi
              label="Last 30 days"
              cost={data.last30d.cost}
              agentCount={data.last30d.agentCount}
              tokens={data.last30d.tokens}
            />
            <SpendKpi
              label="Lifetime"
              cost={data.lifetime.cost}
              agentCount={data.lifetime.agentCount}
              tokens={data.lifetime.tokens}
            />
          </div>
        </section>

        <section className="settings-section">
          <h3 className="settings-h">By project</h3>
          <BucketTable
            buckets={data.byProject}
            emptyHint="No agents have been spawned yet."
          />
        </section>

        <section className="settings-section">
          <h3 className="settings-h">By model</h3>
          <p className="settings-help">
            Attributed to the model selected at spawn time. A future iteration
            could split between sub-model invocations (e.g. Haiku auto-mode
            classifier + Sonnet main turn) using the CLI&apos;s per-turn
            modelUsage breakdown.
          </p>
          <BucketTable
            buckets={data.byModel}
            emptyHint="No model usage yet."
          />
        </section>

        <section className="settings-section">
          <h3 className="settings-h">By role</h3>
          <BucketTable
            buckets={data.byRole}
            emptyHint="No role usage yet."
            tints={ROLE_TINT}
          />
        </section>

        <section className="settings-section">
          <h3 className="settings-h">Top 20 by cost</h3>
          {data.topAgents.length === 0 ? (
            <div className="inline-empty">No agents yet.</div>
          ) : (
            <TopAgentsTable rows={data.topAgents} />
          )}
        </section>
      </div>
    </div>
  );
}

function SpendKpi({
  label,
  cost,
  agentCount,
  tokens,
}: {
  label: string;
  cost: number;
  agentCount: number;
  tokens: number;
}) {
  return (
    <div className="spend-kpi">
      <div className="spend-kpi-label">{label}</div>
      <div className="spend-kpi-cost">{fmt$(cost)}</div>
      <div className="spend-kpi-sub">
        {agentCount} agent{agentCount === 1 ? '' : 's'} · {fmtTokens(tokens)} tokens
      </div>
    </div>
  );
}

function BucketTable({
  buckets,
  emptyHint,
  tints,
}: {
  buckets: SpendBucket[];
  emptyHint: string;
  tints?: Record<string, string>;
}) {
  if (buckets.length === 0) {
    return <div className="inline-empty">{emptyHint}</div>;
  }
  // Find max cost so we can draw a relative bar per row.
  const maxCost = buckets.reduce((m, b) => Math.max(m, b.cost), 0) || 1;
  return (
    <div className="spend-table">
      <div className="spend-row spend-header">
        <span className="spend-cell-label">Bucket</span>
        <span className="spend-cell-num">Agents</span>
        <span className="spend-cell-num">Tokens</span>
        <span className="spend-cell-num">Cost</span>
        <span className="spend-cell-bar" />
      </div>
      {buckets.map((b) => {
        const pct = Math.max(2, Math.round((b.cost / maxCost) * 100));
        const tint = tints?.[b.id];
        return (
          <div className="spend-row" key={b.id}>
            <span className="spend-cell-label">
              {tint && (
                <span
                  className="role-tint"
                  style={{ background: tint, marginRight: 6 }}
                />
              )}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {b.label}
              </span>
            </span>
            <span className="spend-cell-num">{b.agentCount}</span>
            <span className="spend-cell-num">{fmtTokens(b.tokens)}</span>
            <span className="spend-cell-num">{fmt$(b.cost)}</span>
            <span className="spend-cell-bar">
              <span
                className="spend-bar-fill"
                style={{ width: `${pct}%`, background: tint ?? 'var(--accent)' }}
              />
            </span>
          </div>
        );
      })}
    </div>
  );
}

function TopAgentsTable({ rows }: { rows: SpendAgentRow[] }) {
  return (
    <div className="spend-table">
      <div className="spend-row spend-header spend-row-agents">
        <span className="spend-cell-label">Agent</span>
        <span className="spend-cell-num">Project</span>
        <span className="spend-cell-num">Model</span>
        <span className="spend-cell-num">Tokens</span>
        <span className="spend-cell-num">Cost</span>
        <span className="spend-cell-num">Started</span>
      </div>
      {rows.map((a) => (
        <div className="spend-row spend-row-agents" key={a.id}>
          <span className="spend-cell-label">
            <span
              className="role-tint"
              style={{ background: ROLE_TINT[a.role], marginRight: 6 }}
            />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {a.name}
            </span>
            <span
              className="badge"
              style={{
                background: 'transparent',
                color: STATUS_TINT[a.status] ?? 'var(--muted)',
                marginLeft: 6,
              }}
            >
              {a.status}
            </span>
          </span>
          <span className="spend-cell-num" title={a.projectId}>
            {a.projectName}
          </span>
          <span className="spend-cell-num" title={a.model}>
            <code style={{ fontSize: 10 }}>{a.model}</code>
          </span>
          <span className="spend-cell-num">{fmtTokens(a.tokens)}</span>
          <span className="spend-cell-num">{fmt$(a.cost)}</span>
          <span className="spend-cell-num">{fmtRelTime(a.startedAt)}</span>
        </div>
      ))}
    </div>
  );
}
