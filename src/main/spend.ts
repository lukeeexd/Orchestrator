import type {
  AgentRole,
  AgentStatus,
  SpendAgentRow,
  SpendBucket,
  SpendDayBucket,
  SpendSummary,
} from '../shared/types';
import { ROLES } from '../shared/roles';
import { MODEL_LABELS } from '../shared/models';
import { getDb } from './db';
import { listProjects } from './projects';

function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function asNum(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

function parseModelUsage(
  raw: unknown,
): Record<string, { tokens: number; cost: number }> | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const out: Record<string, { tokens: number; cost: number }> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v && typeof v === 'object') {
        const entry = v as { tokens?: number; cost?: number };
        out[k] = {
          tokens: typeof entry.tokens === 'number' ? entry.tokens : 0,
          cost: typeof entry.cost === 'number' ? entry.cost : 0,
        };
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Aggregate cost/token spend across every agent in the database. Runs in
 * one DB roundtrip (well, three: one project lookup map + one big agents
 * scan + the in-memory bucketing happens here). Re-fetched fresh on every
 * IPC call — the renderer's Spend screen pulls it whenever it mounts.
 *
 * No per-turn modelUsage breakdown yet — that data is on result events
 * (the CLI's `modelUsage` field) but we discard it today. A follow-up
 * could capture it and split cost between e.g. the auto-mode classifier
 * Haiku turns and the main Sonnet turn. For now we attribute the agent's
 * total spend to its chosen model.
 */
export function getSpendSummary(): SpendSummary {
  const db = getDb();
  const projectNames = new Map<string, string>();
  for (const p of listProjects()) projectNames.set(p.id, p.name);

  // Pull everything in one go — even with a long history this is cheap
  // because we only need a handful of columns and the agent table grows
  // slowly compared to log_lines.
  const res = db.exec(`
    SELECT id, role, name, status, model, tokens, cost, project_id, started_at, model_usage
    FROM agents
  `);
  const rows: Array<{
    id: string;
    role: AgentRole;
    name: string;
    status: AgentStatus;
    model: string;
    tokens: number;
    cost: number;
    projectId: string;
    startedAt: number;
    modelUsage?: Record<string, { tokens: number; cost: number }>;
  }> = [];
  if (res.length > 0) {
    for (const r of res[0].values) {
      rows.push({
        id: asStr(r[0]),
        role: asStr(r[1]) as AgentRole,
        name: asStr(r[2]),
        status: asStr(r[3]) as AgentStatus,
        model: asStr(r[4]),
        tokens: asNum(r[5]),
        cost: asNum(r[6]),
        projectId: asStr(r[7]),
        startedAt: asNum(r[8]),
        modelUsage: parseModelUsage(r[9]),
      });
    }
  }

  const lifetime = { agentCount: 0, tokens: 0, cost: 0 };
  const last7d = { agentCount: 0, tokens: 0, cost: 0 };
  const last30d = { agentCount: 0, tokens: 0, cost: 0 };
  const projectBuckets = new Map<string, SpendBucket>();
  const modelBuckets = new Map<string, SpendBucket>();
  const roleBuckets = new Map<string, SpendBucket>();
  const dayBuckets = new Map<string, SpendDayBucket>();

  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 3600 * 1000;
  const thirtyDaysAgo = now - 30 * 24 * 3600 * 1000;

  for (const r of rows) {
    lifetime.agentCount += 1;
    lifetime.tokens += r.tokens;
    lifetime.cost += r.cost;
    if (r.startedAt >= sevenDaysAgo) {
      last7d.agentCount += 1;
      last7d.tokens += r.tokens;
      last7d.cost += r.cost;
    }
    if (r.startedAt >= thirtyDaysAgo) {
      last30d.agentCount += 1;
      last30d.tokens += r.tokens;
      last30d.cost += r.cost;
      const dayKey = localDayKey(r.startedAt);
      const dayBucket = dayBuckets.get(dayKey);
      if (dayBucket) {
        dayBucket.agentCount += 1;
        dayBucket.tokens += r.tokens;
        dayBucket.cost += r.cost;
      } else {
        dayBuckets.set(dayKey, {
          date: dayKey,
          agentCount: 1,
          tokens: r.tokens,
          cost: r.cost,
        });
      }
    }
    accumulate(projectBuckets, r.projectId, projectNames.get(r.projectId) ?? '(deleted project)', r);
    // Model breakdown: use the CLI's per-model usage when we captured it
    // (v0.5+) so an agent that ran on Sonnet + Haiku auto-mode classifier
    // shows up in both buckets accurately. Fall back to the agent's
    // chosen model for legacy rows that don't have model_usage yet.
    if (r.modelUsage) {
      for (const [model, mu] of Object.entries(r.modelUsage)) {
        accumulate(modelBuckets, model, MODEL_LABELS[model] ?? model, {
          tokens: mu.tokens,
          cost: mu.cost,
        });
      }
    } else {
      accumulate(modelBuckets, r.model, MODEL_LABELS[r.model] ?? r.model, r);
    }
    accumulate(roleBuckets, r.role, ROLES[r.role]?.label ?? r.role, r);
  }

  // Fill in zero-cost gap days so the bar chart shows a clean 30-day
  // window instead of skipping over inactive days.
  const byDay: SpendDayBucket[] = [];
  for (let i = 29; i >= 0; i--) {
    const ts = now - i * 24 * 3600 * 1000;
    const key = localDayKey(ts);
    byDay.push(
      dayBuckets.get(key) ?? {
        date: key,
        agentCount: 0,
        tokens: 0,
        cost: 0,
      },
    );
  }

  // Top 20 most expensive agents — name + role + model + project so the
  // user can navigate back to investigate. Order by cost desc then by
  // start time desc as a tiebreaker so newest expensive ones surface first.
  const topAgents: SpendAgentRow[] = rows
    .slice()
    .sort((a, b) => {
      if (a.cost !== b.cost) return b.cost - a.cost;
      return b.startedAt - a.startedAt;
    })
    .slice(0, 20)
    .map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      model: r.model,
      status: r.status,
      projectId: r.projectId,
      projectName: projectNames.get(r.projectId) ?? '(deleted project)',
      cost: r.cost,
      tokens: r.tokens,
      startedAt: r.startedAt,
    }));

  return {
    lifetime,
    last7d,
    last30d,
    byProject: bucketsByCost(projectBuckets),
    byModel: bucketsByCost(modelBuckets),
    byRole: bucketsByCost(roleBuckets),
    byDay,
    topAgents,
  };
}

/**
 * Local-timezone YYYY-MM-DD key for bucketing. Local — not UTC — because
 * "Tuesday's spend" should match what the user sees on their calendar,
 * not a UTC sliding window that wraps in the middle of their workday.
 */
function localDayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function accumulate(
  map: Map<string, SpendBucket>,
  id: string,
  label: string,
  r: { tokens: number; cost: number },
): void {
  const existing = map.get(id);
  if (existing) {
    existing.agentCount += 1;
    existing.tokens += r.tokens;
    existing.cost += r.cost;
  } else {
    map.set(id, {
      id,
      label,
      agentCount: 1,
      tokens: r.tokens,
      cost: r.cost,
    });
  }
}

function bucketsByCost(map: Map<string, SpendBucket>): SpendBucket[] {
  return [...map.values()].sort((a, b) => b.cost - a.cost);
}
