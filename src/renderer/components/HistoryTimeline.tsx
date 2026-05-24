import { useMemo } from 'react';
import type { HistoryRow } from '../../shared/types';
import { ROLE_TINT } from '../../shared/roles';

/**
 * F8: Gantt-style timeline view for HistoryScreen. Renders one row per
 * agent with a horizontal bar from startedAt → endedAt (or to "now"
 * for running rows), positioned proportionally across the visible
 * date range.
 *
 * Sequential chains tend to produce short bars packed together — the
 * existing date / project / role / status filters are the zoom
 * mechanism. No per-row interaction in v1 beyond a tooltip; clicking
 * a bar opens the agent in the workspace, same as the table row.
 *
 * Bar colour follows status (terminal-success green, error red,
 * running amber, paused muted). Rows with no startedAt are filtered
 * out — there's nothing to plot.
 */
interface Props {
  rows: HistoryRow[];
  onOpenAgent: (projectId: string, agentId: string) => void;
}

const ROW_HEIGHT = 22;
const LABEL_WIDTH = 220;
const HEADER_HEIGHT = 24;

function statusColour(status: HistoryRow['status']): string {
  if (status === 'done') return 'var(--accent, #4ade80)';
  if (status === 'error') return 'var(--error, #f87171)';
  if (status === 'running' || status === 'waiting' || status === 'approval')
    return 'var(--waiting, #fbbf24)';
  return 'var(--muted-2, #9ca3af)';
}

function fmtTickLabel(ts: number, span: number): string {
  const d = new Date(ts);
  if (span < 24 * 3600 * 1000) {
    // Less than a day visible → show HH:MM
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (span < 30 * 24 * 3600 * 1000) {
    // Less than a month → show "MMM D HH:MM"
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return d.toLocaleDateString();
}

function fmtDuration(ms: number): string {
  if (ms < 0) return '0s';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

export function HistoryTimeline({ rows, onOpenAgent }: Props) {
  // Drop rows missing a startedAt (should be none in practice; defensive).
  const plottable = useMemo(
    () => rows.filter((r) => typeof r.startedAt === 'number' && r.startedAt > 0),
    [rows],
  );

  // The "now" we use for live rows. Snapshotted per-render so all bars
  // share the same right edge — a re-render is the only thing that
  // moves them. A 1Hz ticker would be smoother but adds noise for a
  // view that's already filtered.
  const now = Date.now();

  const range = useMemo(() => {
    if (plottable.length === 0) return null;
    let minStart = Infinity;
    let maxEnd = -Infinity;
    for (const r of plottable) {
      if (r.startedAt < minStart) minStart = r.startedAt;
      const end = r.endedAt ?? now;
      if (end > maxEnd) maxEnd = end;
    }
    // Pad both ends by 2% of the span so bars aren't hard against the edges.
    const span = Math.max(1000, maxEnd - minStart);
    const pad = Math.floor(span * 0.02);
    return {
      start: minStart - pad,
      end: maxEnd + pad,
      span: span + 2 * pad,
    };
  }, [plottable, now]);

  // Sort chronologically (earliest first) so a sequential chain reads
  // top-to-bottom matching wall-clock order.
  const sorted = useMemo(
    () => plottable.slice().sort((a, b) => a.startedAt - b.startedAt),
    [plottable],
  );

  if (!range || sorted.length === 0) {
    return (
      <div className="inline-empty" style={{ padding: 18 }}>
        No agents with a startedAt to plot.
      </div>
    );
  }

  // Pick a handful of evenly-spaced ticks for the time axis.
  const TICK_COUNT = 5;
  const ticks: number[] = [];
  for (let i = 0; i < TICK_COUNT; i++) {
    ticks.push(range.start + (range.span * i) / (TICK_COUNT - 1));
  }

  const totalHeight = HEADER_HEIGHT + sorted.length * ROW_HEIGHT;

  return (
    <div
      style={{
        position: 'relative',
        height: totalHeight,
        background: 'var(--sub-2)',
        borderRadius: 4,
        padding: 8,
        overflow: 'auto',
      }}
    >
      {/* Time axis header */}
      <div
        style={{
          position: 'relative',
          height: HEADER_HEIGHT,
          marginLeft: LABEL_WIDTH,
          borderBottom: '1px solid var(--border)',
        }}
      >
        {ticks.map((t, i) => {
          const pct = ((t - range.start) / range.span) * 100;
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: `${pct}%`,
                top: 0,
                bottom: 0,
                width: 1,
                background: 'var(--border)',
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  top: 2,
                  left: 4,
                  fontSize: 9,
                  color: 'var(--muted-2)',
                  whiteSpace: 'nowrap',
                }}
              >
                {fmtTickLabel(t, range.span)}
              </span>
            </div>
          );
        })}
      </div>

      {/* Per-agent rows */}
      {sorted.map((r, idx) => {
        const start = r.startedAt;
        const end = r.endedAt ?? now;
        const leftPct = ((start - range.start) / range.span) * 100;
        const widthPct = Math.max(
          0.3,
          ((end - start) / range.span) * 100,
        );
        const isLive =
          r.status === 'running' ||
          r.status === 'waiting' ||
          r.status === 'approval';
        return (
          <div
            key={r.id}
            onClick={() => onOpenAgent(r.projectId, r.id)}
            style={{
              position: 'absolute',
              top: HEADER_HEIGHT + idx * ROW_HEIGHT + 8,
              left: 8,
              right: 8,
              height: ROW_HEIGHT - 2,
              display: 'flex',
              alignItems: 'center',
              cursor: 'default',
            }}
            title={`${r.name} · ${r.roleLabel}\n${fmtDuration(end - start)}${
              isLive ? ' (still running)' : ''
            }\nstatus: ${r.statusLabel}\nproject: ${r.projectName}`}
          >
            <div
              style={{
                width: LABEL_WIDTH - 8,
                paddingRight: 8,
                fontSize: 10,
                color: 'var(--text-1)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  background: ROLE_TINT[r.role],
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {r.name}
              </span>
            </div>
            <div
              style={{
                position: 'relative',
                flex: 1,
                height: '100%',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: `${leftPct}%`,
                  width: `${widthPct}%`,
                  top: 2,
                  bottom: 2,
                  borderRadius: 2,
                  background: statusColour(r.status),
                  opacity: isLive ? 0.85 : 0.65,
                  border: isLive ? '1px dashed var(--waiting)' : 'none',
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
