import { useEffect, useState } from 'react';
import type {
  AgentRole,
  SpendAgentRow,
  SpendBucket,
  SpendDayBucket,
  SpendRecommendation,
  SpendSummary,
} from '../../shared/types';
import { ROLE_TINT, STATUS_TINT } from '../../shared/roles';
import { Icon } from './Icon';

/** Subset of RailScreen ids the Spend recommendations panel can deep-link to. */
type SpendDeepLink = 'settings' | 'marketplace' | 'tools' | 'history';

interface Props {
  /** Switch to another rail in response to a recommendation card. */
  onDeepLink?: (rail: SpendDeepLink) => void;
}

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

export function SpendScreen({ onDeepLink }: Props) {
  const [data, setData] = useState<SpendSummary | null>(null);
  const [recommendations, setRecommendations] = useState<
    SpendRecommendation[]
  >([]);
  const [reloading, setReloading] = useState(false);

  const load = async () => {
    setReloading(true);
    try {
      // Two reads in parallel — both are cheap (one agents-table scan,
      // one rule eval over the same data) so we don't gate the screen
      // on the rec call.
      const [summary, recs] = await Promise.all([
        window.api.getSpendSummary(),
        window.api.getSpendRecommendations(),
      ]);
      setData(summary);
      setRecommendations(recs);
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
          onClick={() => void window.api.openClaudeUsage()}
          title="Open claude.ai/settings/usage in your browser for Anthropic's official rate-limit numbers"
        >
          View official usage ↗
        </button>
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

        {recommendations.length > 0 && (
          <section className="settings-section">
            <h3 className="settings-h">Recommendations</h3>
            <p className="settings-help">
              Rule-based nudges over the data above. Each card disappears once
              the underlying condition resolves (e.g. unsubscribing an idle
              bundle, or letting a week pass without an expensive single agent).
            </p>
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              {recommendations.map((rec) => (
                <RecommendationCard
                  key={rec.id}
                  rec={rec}
                  onDeepLink={onDeepLink}
                />
              ))}
            </div>
          </section>
        )}

        <section className="settings-section">
          <h3 className="settings-h">Daily cost · last 30 days</h3>
          <DailyChart days={data.byDay} />
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

function DailyChart({ days }: { days: SpendDayBucket[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const maxCost = days.reduce((m, d) => Math.max(m, d.cost), 0);
  // Layout: 30 bars across a fixed-aspect viewBox. Width 300 (10 units per
  // bar, 1 unit gap), height 80. The renderer's CSS scales it to the
  // section's width via width: 100%.
  const W = 300;
  const H = 80;
  const N = days.length;
  const barGap = 1;
  const barW = (W - (N - 1) * barGap) / N;

  // Avoid dividing by zero when every day is $0 — show flat empty bars
  // with a hint message instead of a misleading uniformly-tall chart.
  const allZero = maxCost === 0;

  // Pick "axis" labels at the start, middle, end of the window. Calendar
  // dates rather than relative ("30d ago") since the chart spans more
  // than a couple of days.
  const labelFor = (i: number) => {
    const d = new Date(days[i].date + 'T00:00:00');
    return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  };

  const hover = hoverIdx != null ? days[hoverIdx] : null;

  return (
    <div className="daily-chart">
      <div className="daily-chart-frame">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="daily-chart-svg"
        >
          {days.map((d, i) => {
            const h = allZero ? 0 : Math.max(1, (d.cost / maxCost) * (H - 8));
            const x = i * (barW + barGap);
            const y = H - h;
            const isHover = hoverIdx === i;
            return (
              <rect
                key={d.date}
                x={x}
                y={y}
                width={barW}
                height={h}
                rx={1}
                fill={
                  d.cost === 0
                    ? 'var(--border-2)'
                    : isHover
                    ? 'var(--accent)'
                    : 'rgba(74, 222, 128, 0.55)'
                }
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}
              >
                <title>
                  {labelFor(i)} · {fmt$(d.cost)} · {d.agentCount} agent
                  {d.agentCount === 1 ? '' : 's'}
                </title>
              </rect>
            );
          })}
        </svg>
        <div className="daily-chart-axis">
          <span>{labelFor(0)}</span>
          <span>{labelFor(Math.floor(N / 2))}</span>
          <span>{labelFor(N - 1)}</span>
        </div>
      </div>
      <div className="daily-chart-readout">
        {hover ? (
          <>
            <strong>{labelFor(hoverIdx ?? 0)}</strong>
            <span className="meta">
              {fmt$(hover.cost)} · {hover.agentCount} agent
              {hover.agentCount === 1 ? '' : 's'} · {fmtTokens(hover.tokens)} tokens
            </span>
          </>
        ) : allZero ? (
          <span className="meta">No spend in the last 30 days.</span>
        ) : (
          <span className="meta">Hover a bar to see that day&apos;s detail.</span>
        )}
      </div>
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

function RecommendationCard({
  rec,
  onDeepLink,
}: {
  rec: SpendRecommendation;
  onDeepLink?: (rail: SpendDeepLink) => void;
}) {
  const tint = rec.severity === 'warn' ? 'var(--waiting)' : 'var(--accent)';
  const deepLinkLabel: Record<SpendDeepLink, string> = {
    settings: 'Open Settings',
    marketplace: 'Open Marketplace',
    tools: 'Open Tools',
    history: 'Open Runs',
  };
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${tint}`,
        borderRadius: 4,
        background: 'var(--sub-1)',
        padding: '8px 12px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          fontWeight: 600,
          marginBottom: 4,
        }}
      >
        <span style={{ color: tint }}>{rec.severity === 'warn' ? '!' : 'i'}</span>
        <span>{rec.title}</span>
        <span className="spacer" style={{ flex: 1 }} />
        {rec.deepLink && onDeepLink && (
          <button
            className="tb-btn"
            onClick={() => onDeepLink(rec.deepLink as SpendDeepLink)}
            style={{ height: 20, fontSize: 11 }}
            title={`Switch to the ${rec.deepLink} rail`}
          >
            {deepLinkLabel[rec.deepLink]}
          </button>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.4 }}>
        {rec.body}
      </div>
    </div>
  );
}
