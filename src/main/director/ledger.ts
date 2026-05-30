import type {
  BlackboardEntry,
  LedgerRow,
  PlanRow,
  RunLedger,
} from '../../shared/types';

/**
 * N5 — Task + Progress Ledger derivation (the safe half: surface + pause, no
 * auto-replan).
 *
 * Pure function: given the plan rows, the actual spawned agent id per row, the
 * blackboard entries accumulated so far, and which row is currently running, it
 * produces the `RunLedger` that rides on the plan's DirectorMessage. The accept
 * loop (`ipc/director.ts`) calls this after each `awaitCompletion` and patches
 * the result onto the message; the renderer's LedgerCard renders it.
 *
 * No I/O, no clock — `updatedAt` is passed in so the function stays
 * deterministic and unit-testable.
 */

/** Consecutive no-progress steps that pause a run (Magentic-One's threshold). */
export const STALL_LIMIT = 2;

export interface DeriveLedgerInput {
  runId: string;
  rows: PlanRow[];
  /**
   * The real agent id spawned for each row, by index. `undefined` for a row
   * that hasn't been spawned yet. Correlation is by id (not position or name)
   * so a manual spawn mid-run can't shift the mapping.
   */
  agentIdByRow: Array<string | undefined>;
  /** Blackboard entries for this run, any order. */
  entries: BlackboardEntry[];
  /** Index of the row whose agent is currently running; -1 when none. */
  activeRowIndex: number;
  /** Caller-supplied timestamp (keeps this function clock-free). */
  updatedAt: number;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

/**
 * Deterministic, false-positive-averse "no measurable progress" signal for a
 * completed step. Conservative on purpose: a false pause costs the user a
 * manual restart, so we only flag a step that either errored while changing
 * nothing, or repeated the previous step's exact file set while tests still
 * fail. A clean read-only step (researcher/pm: no files, no errors, no failing
 * tests) is NOT a stall — both clauses require errors or failing tests, so
 * those roles never trip it on the no-files condition alone.
 */
function isNoProgress(
  entry: BlackboardEntry,
  prev: BlackboardEntry | null,
): boolean {
  const failingTests = entry.testsRun != null && entry.testsRun.fail > 0;
  const noTests = entry.testsRun == null;
  const erroredNoChange =
    entry.errors.length > 0 &&
    entry.filesTouched.length === 0 &&
    (noTests || failingTests);
  const repeatingSameFiles =
    prev != null && sameSet(entry.filesTouched, prev.filesTouched) && failingTests;
  return erroredNoChange || repeatingSameFiles;
}

export function deriveLedger(input: DeriveLedgerInput): RunLedger {
  const { runId, rows, agentIdByRow, entries, activeRowIndex, updatedAt } =
    input;

  const byAgentId = new Map<string, BlackboardEntry>();
  for (const e of entries) byAgentId.set(e.agentId, e);

  const ledgerRows: LedgerRow[] = [];
  // Completed entries in plan-row order — the sequence the stall counter walks.
  const doneInOrder: BlackboardEntry[] = [];

  rows.forEach((row, i) => {
    const agentId = agentIdByRow[i];
    const entry = agentId ? byAgentId.get(agentId) : undefined;
    let status: LedgerRow['status'];
    let evidence: LedgerRow['evidence'];

    if (entry) {
      status = 'done';
      evidence = {
        filesTouched: entry.filesTouched.length,
        testsRun: entry.testsRun,
        errors: entry.errors.length,
        ...(entry.summary ? { summary: entry.summary } : {}),
      };
      doneInOrder.push(entry);
    } else if (agentId && i === activeRowIndex) {
      status = 'active';
    } else if (agentId) {
      // Spawned and terminated, but no success entry was recorded — the agent
      // errored or was aborted before handing off.
      status = 'failed';
    } else {
      status = 'pending';
    }

    ledgerRows.push({
      i: row.i,
      role: row.role,
      name: row.name,
      task: row.task,
      status,
      ...(evidence ? { evidence } : {}),
    });
  });

  // Stall count: walk completed steps in order, increment on no-progress,
  // reset to 0 on any productive step.
  let stallCount = 0;
  let prev: BlackboardEntry | null = null;
  for (const e of doneInOrder) {
    stallCount = isNoProgress(e, prev) ? stallCount + 1 : 0;
    prev = e;
  }

  const stalled = stallCount >= STALL_LIMIT;
  const pausedReason = stalled
    ? `${stallCount} consecutive steps made no measurable progress (no files changed and/or tests still failing). Paused for review — redirect the last agent or send new guidance to continue.`
    : undefined;

  return {
    runId,
    rows: ledgerRows,
    stallCount,
    stalled,
    ...(pausedReason ? { pausedReason } : {}),
    updatedAt,
  };
}
