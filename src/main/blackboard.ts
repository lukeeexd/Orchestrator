import { randomUUID } from 'node:crypto';
import { getDb, scheduleSave } from './db';
import { formatRunDigest } from './runDigest';
import { readSettings } from './settings';
import type {
  AgentRole,
  BlackboardEntry,
  HandoffPayload,
} from '../shared/types';

/**
 * N6 — run-scoped blackboard: the durable storage layer behind the N5
 * progress ledger.
 *
 * One `blackboard_entries` row per agent completion during an accepted-plan
 * run, tagged with the `runId` (= the plan's DirectorMessage id). The accept
 * loop (`ipc/director.ts`) brackets a run with `beginRun`/`endRun`; the agent
 * completion chokepoint (`agents/query.ts`) calls `recordCompletion`, which
 * resolves the live run and appends an entry. Outside a run there is no active
 * run, so `recordCompletion` is a no-op — user-spawned agents don't pollute the
 * store in this (safe-half) MVP.
 *
 * Schema lives in migration v33. This module is the only place that touches
 * the table.
 */

/** Newest-N entries kept per run; older ones are pruned after each append. */
const BLACKBOARD_CAP = 50;

const ROLE_VALUES = new Set<AgentRole>([
  'pm',
  'researcher',
  'coder',
  'qa',
  'devops',
  'security',
]);

function isRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && ROLE_VALUES.has(value as AgentRole);
}

// ───────────────────────── active-run registry ─────────────────────────

/**
 * The live run per project. Set when an accepted plan starts spawning and
 * cleared when the run ends (or halts). In-memory only — a run that's
 * interrupted by an app restart simply has no active run on the next launch,
 * which is correct (the loop that drives it doesn't survive a restart either).
 */
const activeRuns = new Map<string, string>();

/**
 * PRE-2a: per-run count of director-driven agent spawns (plan rows + N3 gate
 * fix-redirects + future N5 auto-replan / N1 re-spawns). The backstop against
 * an auto-loop minting unbounded agents now that per-agent budgets are gone.
 * Same in-memory, per-run lifecycle as `activeRuns` (reset on beginRun, cleared
 * on endRun); user-spawned agents never touch it.
 */
const activeRunSpawns = new Map<string, number>();

export function beginRun(projectId: string, runId: string): void {
  activeRuns.set(projectId, runId);
  activeRunSpawns.set(projectId, 0);
}

export function endRun(projectId: string): void {
  activeRuns.delete(projectId);
  activeRunSpawns.delete(projectId);
}

export function activeRun(projectId: string): string | undefined {
  return activeRuns.get(projectId);
}

// ─────────────────────────── PRE-2a spawn cap ───────────────────────────

/** Count one director-driven spawn against the run. Returns the new count. */
export function recordSpawn(projectId: string): number {
  const next = (activeRunSpawns.get(projectId) ?? 0) + 1;
  activeRunSpawns.set(projectId, next);
  return next;
}

/** Spawns recorded for the project's active run so far. */
export function runSpawnCount(projectId: string): number {
  return activeRunSpawns.get(projectId) ?? 0;
}

/**
 * Whether the run has hit its spawn cap. The cap is the global
 * `maxSpawnsPerRun` setting (0 = unlimited/off). Read this BEFORE minting a new
 * agent (rows 1+, gate fix-redirects, future auto-replan); when exhausted the
 * caller surfaces + halts (no auto-replan past the cap). `remaining` lets a
 * future N5 auto-replan size its replan to the budget left.
 */
export function spawnBudgetExhausted(projectId: string): {
  exhausted: boolean;
  count: number;
  cap: number;
  remaining: number;
} {
  const cap = readSettings().maxSpawnsPerRun ?? 0;
  const count = runSpawnCount(projectId);
  const remaining = cap > 0 ? Math.max(0, cap - count) : Infinity;
  return { exhausted: cap > 0 && count >= cap, count, cap, remaining };
}

// ───────────────────────────── storage ─────────────────────────────

/**
 * Append a completion entry for whatever run is live in this project. No-op
 * when no run is active (so non-plan / user-spawned completions are ignored)
 * or when the role is unrecognised. Returns the stored entry, or null on no-op.
 *
 * Called synchronously from inside the agent's run (the `result` handler in
 * query.ts), which is part of the promise `awaitCompletion` tracks — so the
 * entry is always written before the accept loop's `await awaitCompletion`
 * resumes and reads it back via `listEntries`.
 */
export function recordCompletion(input: {
  projectId: string;
  agentId: string;
  agentName: string;
  role: AgentRole;
  payload: HandoffPayload;
}): BlackboardEntry | null {
  const runId = activeRuns.get(input.projectId);
  if (!runId) return null;
  if (!isRole(input.role)) return null;

  const entry: BlackboardEntry = {
    id: randomUUID(),
    projectId: input.projectId,
    runId,
    agentId: input.agentId,
    agentName: input.agentName,
    role: input.role,
    ts: Date.now(),
    summary: input.payload.summary ?? '',
    filesTouched: input.payload.files_touched ?? [],
    testsRun: input.payload.tests_run ?? null,
    errors: input.payload.errors ?? [],
    todos: input.payload.todos ?? [],
  };

  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO blackboard_entries
      (id, project_id, run_id, agent_id, agent_name, role, ts, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run([
    entry.id,
    entry.projectId,
    entry.runId,
    entry.agentId,
    entry.agentName,
    entry.role,
    entry.ts,
    JSON.stringify({
      summary: entry.summary,
      filesTouched: entry.filesTouched,
      testsRun: entry.testsRun,
      errors: entry.errors,
      todos: entry.todos,
    }),
  ]);
  stmt.free();

  // Prune to the newest BLACKBOARD_CAP for this run so a long, chatty run
  // can't grow the table unbounded. The ledger only needs one entry per row.
  const prune = db.prepare(`
    DELETE FROM blackboard_entries
    WHERE project_id = ? AND run_id = ? AND id NOT IN (
      SELECT id FROM blackboard_entries
      WHERE project_id = ? AND run_id = ?
      ORDER BY ts DESC LIMIT ?
    )
  `);
  prune.run([
    entry.projectId,
    entry.runId,
    entry.projectId,
    entry.runId,
    BLACKBOARD_CAP,
  ]);
  prune.free();

  scheduleSave();
  return entry;
}

/** All entries for a run, oldest-first (the order agents completed). */
export function listEntries(
  projectId: string,
  runId: string,
): BlackboardEntry[] {
  const db = getDb();
  const result = db.exec(
    `SELECT id, project_id, run_id, agent_id, agent_name, role, ts, payload
       FROM blackboard_entries
      WHERE project_id = ? AND run_id = ?
      ORDER BY ts ASC`,
    [projectId, runId],
  );
  if (result.length === 0) return [];
  const out: BlackboardEntry[] = [];
  for (const row of result[0].values) {
    if (!isRole(row[5])) continue;
    let payload: Partial<BlackboardEntry> = {};
    try {
      payload = JSON.parse(String(row[7]));
    } catch {
      payload = {};
    }
    out.push({
      id: String(row[0]),
      projectId: String(row[1]),
      runId: String(row[2]),
      agentId: typeof row[3] === 'string' ? row[3] : '',
      agentName: String(row[4]),
      role: row[5],
      ts: typeof row[6] === 'number' ? row[6] : 0,
      summary: typeof payload.summary === 'string' ? payload.summary : '',
      filesTouched: Array.isArray(payload.filesTouched)
        ? payload.filesTouched
        : [],
      testsRun: payload.testsRun ?? null,
      errors: Array.isArray(payload.errors) ? payload.errors : [],
      todos: Array.isArray(payload.todos) ? payload.todos : [],
    });
  }
  return out;
}

// ─────────────────────────── injection digest ───────────────────────────

/**
 * Build the run-context digest to inject into an agent spawning into the
 * project's active run. Returns null when there is no active run, or no prior
 * entries yet — so the first row of a plan (and any user-spawned agent outside
 * a run) gets nothing. Formatting is delegated to the pure `formatRunDigest`
 * (runDigest.ts); read at spawn time in `agents/spawn.ts`.
 */
export function buildInjectionDigest(projectId: string): string | null {
  const runId = activeRuns.get(projectId);
  if (!runId) return null;
  const digest = formatRunDigest(listEntries(projectId, runId));
  return digest.length > 0 ? digest : null;
}
