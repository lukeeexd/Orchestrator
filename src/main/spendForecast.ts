import type {
  AgentRole,
  PlanCostForecast,
  PlanRow,
} from '../shared/types';
import { getDb } from './db';

/**
 * F7: pre-spawn cost forecast. Reads completed agents from the
 * `agents` table, computes per-role median cost, and sums for the
 * given plan rows. Returns a ±50% band; midpoint is the sum of
 * per-row medians.
 *
 * Why median (not mean): a few outlier runs (mistaken-Opus-on-a-trivial-task)
 * skew the mean badly. Median is the more honest "if I run this
 * role again, what's it likely to cost." Pairs naturally with the
 * Spend optimizer rules in `spendRecommendations.ts` that already
 * treat per-role share as the signal.
 *
 * Why ±50%: wide enough that the user reads the chip as "ballpark"
 * not "promise." Real per-task variance is much larger; a narrower
 * band would mislead. We deliberately don't try to model task-text
 * length or model-selection adjustment in v1 — the median plus
 * row-count is the high-signal piece.
 */

const MIN_SAMPLES_FOR_HISTORY = 3;
const BAND = 0.5;

interface MedianEntry {
  role: AgentRole;
  count: number;
  medianUsd: number;
}

export function forecastPlanCost(rows: PlanRow[]): PlanCostForecast {
  if (rows.length === 0) {
    return {
      lowUsd: 0,
      highUsd: 0,
      midUsd: 0,
      basis: 'no-history',
      perRole: [],
    };
  }
  const medians = perRoleMedians();
  // Roles in the plan, in encounter order (so the perRole array is
  // stable for tooltip display).
  const counts = new Map<AgentRole, number>();
  for (const r of rows) {
    counts.set(r.role, (counts.get(r.role) ?? 0) + 1);
  }

  const perRole: PlanCostForecast['perRole'] = [];
  let mid = 0;
  let everyRoleHasHistory = true;
  let anyRoleHasHistory = false;

  for (const [role, rowCount] of counts) {
    const m = medians.get(role);
    if (m && m.count >= MIN_SAMPLES_FOR_HISTORY) {
      anyRoleHasHistory = true;
      mid += m.medianUsd * rowCount;
      perRole.push({
        role,
        sampleCount: m.count,
        medianUsd: m.medianUsd,
        rowCount,
      });
    } else {
      everyRoleHasHistory = false;
      perRole.push({
        role,
        sampleCount: m?.count ?? 0,
        medianUsd: 0,
        rowCount,
      });
    }
  }

  if (!anyRoleHasHistory) {
    return {
      lowUsd: 0,
      highUsd: 0,
      midUsd: 0,
      basis: 'no-history',
      perRole,
    };
  }
  return {
    lowUsd: mid * (1 - BAND),
    highUsd: mid * (1 + BAND),
    midUsd: mid,
    basis: everyRoleHasHistory ? 'history' : 'partial',
    perRole,
  };
}

/**
 * Per-role median of completed-agent cost. Excludes:
 *   - zero-cost rows (still-running, errored-before-spend, free-tier
 *     OAuth agents whose CLI doesn't report cost). Including them
 *     would drag the median toward zero and underestimate.
 *   - rows older than 60 days. The optimum mix of model + role
 *     drifts as we change defaults; a stale 6-month median isn't
 *     a useful predictor of next week's run.
 */
function perRoleMedians(): Map<AgentRole, MedianEntry> {
  const out = new Map<AgentRole, MedianEntry>();
  let db;
  try {
    db = getDb();
  } catch {
    return out;
  }
  const cutoff = Date.now() - 60 * 24 * 3600 * 1000;
  const res = db.exec(
    `SELECT role, cost FROM agents
     WHERE cost > 0
       AND started_at >= ${cutoff}
     ORDER BY role`,
  );
  if (res.length === 0) return out;
  const byRole = new Map<AgentRole, number[]>();
  for (const row of res[0].values) {
    const role = typeof row[0] === 'string' ? (row[0] as AgentRole) : null;
    const cost = typeof row[1] === 'number' ? row[1] : 0;
    if (!role || cost <= 0) continue;
    const list = byRole.get(role) ?? [];
    list.push(cost);
    byRole.set(role, list);
  }
  for (const [role, costs] of byRole) {
    out.set(role, {
      role,
      count: costs.length,
      medianUsd: median(costs),
    });
  }
  return out;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
