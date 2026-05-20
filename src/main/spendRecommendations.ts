import type { AgentRole, SpendRecommendation } from '../shared/types';
import { ROLES } from '../shared/roles';
import { getDb } from './db';
import { listProjects } from './projects';
import * as marketplace from './marketplace';
import { MARKETPLACE_GLOBAL_SCOPE_ID } from '../shared/ipc';

/**
 * Rule-based cost / loadout recommendations surfaced on the Spend
 * screen. Pure derivations over data we already collect — no LLM,
 * no external calls, fast enough to recompute every time the user
 * opens the Spend rail. Each rule yields at most one card so the
 * panel doesn't drown the user in suggestions.
 *
 * Rules:
 *   role-share-dominance   — a role consumes >50% of last-30d spend
 *   expensive-single-agent — one agent consumes >25% of last-7d spend
 *   failed-expensive       — error/aborted agent in last 7d with cost > $0.10
 *   idle-subscription      — subscribed bundle with 0 fires lifetime, >7d old
 *
 * Threshold tuning lives at the top of each function so they're easy
 * to tweak as we get usage data.
 */

function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function asNum(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

interface AgentSummaryRow {
  id: string;
  role: AgentRole;
  name: string;
  status: string;
  model: string;
  cost: number;
  startedAt: number;
  projectId: string;
}

function loadAgents(): AgentSummaryRow[] {
  const db = getDb();
  const res = db.exec(`
    SELECT id, role, name, status, model, cost, started_at, project_id
    FROM agents
  `);
  if (res.length === 0) return [];
  return res[0].values.map((r) => ({
    id: asStr(r[0]),
    role: asStr(r[1]) as AgentRole,
    name: asStr(r[2]),
    status: asStr(r[3]),
    model: asStr(r[4]),
    cost: asNum(r[5]),
    startedAt: asNum(r[6]),
    projectId: asStr(r[7]),
  }));
}

// ──────────────────────────── Rule 1 ────────────────────────────

/**
 * If one role accounts for more than this fraction of last-30d cost,
 * surface a "your spend is concentrated here" nudge.
 */
const ROLE_DOMINANCE_THRESHOLD = 0.5;
/** Skip the rule entirely below this absolute total — it's noise on tiny windows. */
const ROLE_DOMINANCE_MIN_TOTAL = 1.0;

function roleShareDominance(
  agents: AgentSummaryRow[],
  now: number,
): SpendRecommendation | null {
  const thirtyDaysAgo = now - 30 * 24 * 3600 * 1000;
  const recent = agents.filter((a) => a.startedAt >= thirtyDaysAgo);
  let total = 0;
  const byRole = new Map<AgentRole, number>();
  for (const a of recent) {
    total += a.cost;
    byRole.set(a.role, (byRole.get(a.role) ?? 0) + a.cost);
  }
  if (total < ROLE_DOMINANCE_MIN_TOTAL) return null;
  for (const [role, cost] of byRole) {
    const share = cost / total;
    if (share >= ROLE_DOMINANCE_THRESHOLD) {
      const pct = Math.round(share * 100);
      const label = ROLES[role]?.label ?? role;
      return {
        id: `role-dominance-${role}`,
        severity: 'info',
        title: `${label} drove ${pct}% of last-30d spend`,
        body:
          `${label} agents have consumed $${cost.toFixed(2)} of the last 30 days' ` +
          `$${total.toFixed(2)} total. If most of that work was routine, consider ` +
          `setting a cheaper default model for ${role} via Settings → Defaults.`,
        deepLink: 'settings',
      };
    }
  }
  return null;
}

// ──────────────────────────── Rule 2 ────────────────────────────

const EXPENSIVE_AGENT_THRESHOLD = 0.25;
const EXPENSIVE_AGENT_MIN_TOTAL = 0.5;

function expensiveSingleAgent(
  agents: AgentSummaryRow[],
  now: number,
): SpendRecommendation | null {
  const sevenDaysAgo = now - 7 * 24 * 3600 * 1000;
  const recent = agents.filter((a) => a.startedAt >= sevenDaysAgo);
  if (recent.length < 2) return null;
  const total = recent.reduce((n, a) => n + a.cost, 0);
  if (total < EXPENSIVE_AGENT_MIN_TOTAL) return null;
  const top = recent.reduce((best, a) => (a.cost > best.cost ? a : best));
  const share = top.cost / total;
  if (share < EXPENSIVE_AGENT_THRESHOLD) return null;
  const pct = Math.round(share * 100);
  return {
    id: `expensive-agent-${top.id}`,
    severity: 'warn',
    title: `One agent consumed ${pct}% of last-7d spend`,
    body:
      `${top.name} (${ROLES[top.role]?.label ?? top.role}) cost $${top.cost.toFixed(2)} of ` +
      `the week's $${total.toFixed(2)} total. Check Runs to see what it did — ` +
      `a single big agent often means a model + task mismatch that's worth tightening.`,
    deepLink: 'history',
  };
}

// ──────────────────────────── Rule 3 ────────────────────────────

const FAILED_EXPENSIVE_COST_MIN = 0.1;

function failedExpensive(
  agents: AgentSummaryRow[],
  now: number,
): SpendRecommendation | null {
  const sevenDaysAgo = now - 7 * 24 * 3600 * 1000;
  const failures = agents.filter(
    (a) =>
      a.startedAt >= sevenDaysAgo &&
      (a.status === 'error' || a.status === 'aborted') &&
      a.cost >= FAILED_EXPENSIVE_COST_MIN,
  );
  if (failures.length === 0) return null;
  const totalLost = failures.reduce((n, a) => n + a.cost, 0);
  const top = failures.reduce((best, a) => (a.cost > best.cost ? a : best));
  const label = failures.length === 1 ? '1 failed run' : `${failures.length} failed runs`;
  return {
    id: 'failed-expensive',
    severity: 'warn',
    title: `${label} cost $${totalLost.toFixed(2)} this week`,
    body:
      failures.length === 1
        ? `${top.name} ${top.status === 'error' ? 'errored' : 'was aborted'} ` +
          `after spending $${top.cost.toFixed(2)}. Open it in Runs to see what went wrong.`
        : `${failures.length} agents errored or were aborted after spending ` +
          `$${FAILED_EXPENSIVE_COST_MIN.toFixed(2)}+ each. Highest was ${top.name} at ` +
          `$${top.cost.toFixed(2)}. Worth a look before they cost more.`,
    deepLink: 'history',
  };
}

// ──────────────────────────── Rule 4 ────────────────────────────

const IDLE_SUBSCRIPTION_MIN_AGE_MS = 7 * 24 * 3600 * 1000;

function idleSubscription(now: number): SpendRecommendation | null {
  // Collect every subscription across every project + the global scope.
  // A bundle is idle if NO project's fire-count table has any row
  // referencing it — fires bucket by (project, role, source, bundle, skill),
  // so any non-zero record across any project counts as "this bundle has
  // fired somewhere".
  const subs: Array<{
    sourceId: string;
    bundleId: string;
    subscribedAt: number;
  }> = [];
  const seen = new Set<string>();
  const seenKey = (sourceId: string, bundleId: string) =>
    `${sourceId}\x00${bundleId}`;
  // Global first so it wins the dedupe — the global subscription's
  // subscribedAt is what we report.
  for (const s of marketplace.listSubscriptions(MARKETPLACE_GLOBAL_SCOPE_ID)) {
    const k = seenKey(s.sourceId, s.bundleId);
    if (seen.has(k)) continue;
    seen.add(k);
    subs.push({
      sourceId: s.sourceId,
      bundleId: s.bundleId,
      subscribedAt: s.subscribedAt,
    });
  }
  for (const p of listProjects()) {
    for (const s of marketplace.listSubscriptions(p.id)) {
      const k = seenKey(s.sourceId, s.bundleId);
      if (seen.has(k)) continue;
      seen.add(k);
      subs.push({
        sourceId: s.sourceId,
        bundleId: s.bundleId,
        subscribedAt: s.subscribedAt,
      });
    }
  }

  // Fast lookup of "has any fire for this (source, bundle)" by walking
  // every project's fire-count rows.
  const firedBundles = new Set<string>();
  for (const p of listProjects()) {
    for (const fc of marketplace.getSkillFireCounts(p.id)) {
      if (fc.count > 0) {
        firedBundles.add(seenKey(fc.sourceId, fc.bundleId));
      }
    }
  }

  const idle = subs.filter(
    (s) =>
      now - s.subscribedAt >= IDLE_SUBSCRIPTION_MIN_AGE_MS &&
      !firedBundles.has(seenKey(s.sourceId, s.bundleId)),
  );
  if (idle.length === 0) return null;
  const first = idle[0];
  return {
    id: 'idle-subscription',
    severity: 'info',
    title:
      idle.length === 1
        ? `1 subscribed bundle has never fired`
        : `${idle.length} subscribed bundles have never fired`,
    body:
      idle.length === 1
        ? `${first.sourceId}/${first.bundleId} has been subscribed for over a week ` +
          `but no skill from it has fired in any run. Consider unsubscribing in ` +
          `the Marketplace rail to keep your loadouts tight.`
        : `Including ${first.sourceId}/${first.bundleId}. Each subscribed bundle ` +
          `that doesn't fire adds noise to the agents' available-skill list. Prune ` +
          `via the Marketplace rail.`,
    deepLink: 'marketplace',
  };
}

// ──────────────────────────────────────────────────────────────────

export function getSpendRecommendations(): SpendRecommendation[] {
  const now = Date.now();
  const agents = loadAgents();
  const out: SpendRecommendation[] = [];

  const r1 = roleShareDominance(agents, now);
  if (r1) out.push(r1);
  const r2 = expensiveSingleAgent(agents, now);
  if (r2) out.push(r2);
  const r3 = failedExpensive(agents, now);
  if (r3) out.push(r3);
  const r4 = idleSubscription(now);
  if (r4) out.push(r4);

  return out;
}
