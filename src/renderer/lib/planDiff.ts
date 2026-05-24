import type { DirectorMessage, PlanRow } from '../../shared/types';

/**
 * F2: diff two consecutive plans the Director emitted, so the renderer
 * can surface what changed when a re-plan replaces an earlier card.
 * Pure data: no DOM, no React — testable in isolation.
 *
 * Match strategy: `(role, name)` tuple is the row identity. Names are
 * typically unique within a plan (the Director picks descriptive ones
 * like `gate-qa`, `auth-coder`, etc.); combined with `role` they
 * disambiguate the rare case where two plans pick the same name for
 * different roles. The `i` index field is deliberately not the match
 * key because the Director frequently renumbers across re-plans.
 *
 * Duplicate (role, name) pairs within a single plan are matched
 * greedily in encounter order — the first prev row with that key
 * pairs with the first current row, and so on.
 */

export type PlanRowDiffStatus = 'added' | 'modified' | 'unchanged';

export interface PlanRowDiff {
  row: PlanRow;
  status: PlanRowDiffStatus;
  /** Set when status === 'modified' — the prior turn's task text. */
  prevTask?: string;
}

export interface PlanDiff {
  /** Each current row annotated with its diff status, in original order. */
  rows: PlanRowDiff[];
  /** Prev rows that have no counterpart in current — dropped from the plan. */
  removed: PlanRow[];
  summary: { added: number; modified: number; removed: number; unchanged: number };
}

function keyOf(row: PlanRow): string {
  return `${row.role}\x00${row.name}`;
}

export function diffPlans(current: PlanRow[], prev: PlanRow[]): PlanDiff {
  // Build a multi-map of prev rows by (role, name) so duplicates work.
  // Greedy consumption: when a current row matches, it pops the first
  // remaining prev row with that key.
  const prevByKey = new Map<string, PlanRow[]>();
  for (const r of prev) {
    const k = keyOf(r);
    const list = prevByKey.get(k);
    if (list) list.push(r);
    else prevByKey.set(k, [r]);
  }

  const rows: PlanRowDiff[] = [];
  let added = 0;
  let modified = 0;
  let unchanged = 0;

  for (const cur of current) {
    const k = keyOf(cur);
    const bucket = prevByKey.get(k);
    if (!bucket || bucket.length === 0) {
      rows.push({ row: cur, status: 'added' });
      added++;
      continue;
    }
    const match = bucket.shift()!;
    if (match.task !== cur.task) {
      rows.push({ row: cur, status: 'modified', prevTask: match.task });
      modified++;
    } else {
      rows.push({ row: cur, status: 'unchanged' });
      unchanged++;
    }
  }

  // Anything left in prevByKey wasn't matched by a current row → removed.
  const removed: PlanRow[] = [];
  for (const list of prevByKey.values()) {
    for (const r of list) removed.push(r);
  }

  return {
    rows,
    removed,
    summary: { added, modified, removed: removed.length, unchanged },
  };
}

/**
 * Look back through a message list from `idx` to find the most recent
 * prior message with a non-empty `plan` field. Used by DirectorPane /
 * DirectorStream when rendering a plan card to give PlanCard its
 * `prevRows` baseline for the diff.
 */
export function findPrevPlanRows(
  messages: DirectorMessage[],
  idx: number,
): PlanRow[] | undefined {
  for (let i = idx - 1; i >= 0; i--) {
    const p = messages[i].plan;
    if (p && p.length > 0) return p;
  }
  return undefined;
}
