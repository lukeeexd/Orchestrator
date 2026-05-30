import { describe, it, expect } from 'vitest';
import { deriveLedger, STALL_LIMIT } from '../../src/main/director/ledger';
import type {
  BlackboardEntry,
  PlanRow,
  TestsRunSummary,
} from '../../src/shared/types';

function row(i: number, over: Partial<PlanRow> = {}): PlanRow {
  return { i, role: 'coder', name: `coder-${i}`, task: `task ${i}`, ...over };
}

function entry(
  agentId: string,
  over: Partial<BlackboardEntry> = {},
): BlackboardEntry {
  return {
    id: `${agentId}-e`,
    projectId: 'p',
    runId: 'r',
    agentId,
    agentName: agentId,
    role: 'coder',
    ts: 0,
    summary: '',
    filesTouched: [],
    testsRun: null,
    errors: [],
    todos: [],
    ...over,
  };
}

const failing: TestsRunSummary = { pass: 0, fail: 2, skip: 0 };
const green: TestsRunSummary = { pass: 5, fail: 0, skip: 1 };

function derive(input: {
  rows: PlanRow[];
  agentIdByRow: Array<string | undefined>;
  entries: BlackboardEntry[];
  activeRowIndex: number;
}) {
  return deriveLedger({ runId: 'r', updatedAt: 0, ...input });
}

describe('deriveLedger — status mapping', () => {
  it('maps done / active / pending by row position via agentId', () => {
    const led = derive({
      rows: [row(1), row(2), row(3), row(4)],
      agentIdByRow: ['a0', 'a1', 'a2', undefined],
      entries: [entry('a0'), entry('a1')],
      activeRowIndex: 2,
    });
    expect(led.rows.map((r) => r.status)).toEqual([
      'done',
      'done',
      'active',
      'pending',
    ]);
  });

  it('marks a spawned-but-entryless, non-active row as failed', () => {
    // a1 was spawned and terminated without a success entry (errored/aborted)
    const led = derive({
      rows: [row(1), row(2)],
      agentIdByRow: ['a0', 'a1'],
      entries: [entry('a0')],
      activeRowIndex: -1,
    });
    expect(led.rows.map((r) => r.status)).toEqual(['done', 'failed']);
  });

  it('attaches evidence (counts + summary) to a completed row', () => {
    const led = derive({
      rows: [row(1)],
      agentIdByRow: ['a0'],
      entries: [
        entry('a0', {
          filesTouched: ['x.ts', 'y.ts'],
          testsRun: green,
          errors: ['boom'],
          summary: 'did the thing',
        }),
      ],
      activeRowIndex: -1,
    });
    expect(led.rows[0].evidence).toEqual({
      filesTouched: 2,
      testsRun: green,
      errors: 1,
      summary: 'did the thing',
    });
  });
});

describe('deriveLedger — stall counting', () => {
  it('one no-progress step is below STALL_LIMIT (not paused)', () => {
    const led = derive({
      rows: [row(1), row(2)],
      agentIdByRow: ['a0', undefined],
      entries: [entry('a0', { errors: ['e1'] })], // errored, no files, no tests
      activeRowIndex: -1,
    });
    expect(led.stallCount).toBe(1);
    expect(led.stalled).toBe(false);
    expect(led.pausedReason).toBeUndefined();
  });

  it('two consecutive errored no-change steps trip the stall (errored-no-change)', () => {
    const led = derive({
      rows: [row(1), row(2)],
      agentIdByRow: ['a0', 'a1'],
      entries: [
        entry('a0', { errors: ['e1'] }),
        entry('a1', { errors: ['e2'] }),
      ],
      activeRowIndex: -1,
    });
    expect(led.stallCount).toBe(STALL_LIMIT);
    expect(led.stalled).toBe(true);
    expect(led.pausedReason).toBeTruthy();
  });

  it('repeating the same file set with failing tests counts as no-progress', () => {
    // step 0 changes f.ts (productive-ish: not flagged). steps 1 & 2 re-touch
    // the same file with tests still failing → two repeats → stalled.
    const led = derive({
      rows: [row(1), row(2), row(3)],
      agentIdByRow: ['a0', 'a1', 'a2'],
      entries: [
        entry('a0', { filesTouched: ['f.ts'], testsRun: failing }),
        entry('a1', { filesTouched: ['f.ts'], testsRun: failing }),
        entry('a2', { filesTouched: ['f.ts'], testsRun: failing }),
      ],
      activeRowIndex: -1,
    });
    expect(led.stallCount).toBe(2);
    expect(led.stalled).toBe(true);
  });

  it('a productive step resets the stall counter', () => {
    const led = derive({
      rows: [row(1), row(2)],
      agentIdByRow: ['a0', 'a1'],
      entries: [
        entry('a0', { errors: ['e1'] }), // no-progress → 1
        entry('a1', { filesTouched: ['new.ts'], testsRun: green }), // productive → reset
      ],
      activeRowIndex: -1,
    });
    expect(led.stallCount).toBe(0);
    expect(led.stalled).toBe(false);
  });

  it('read-only roles with no files / no errors / no tests never stall', () => {
    const led = derive({
      rows: [row(1, { role: 'researcher' }), row(2, { role: 'researcher' })],
      agentIdByRow: ['a0', 'a1'],
      entries: [
        entry('a0', { role: 'researcher' }),
        entry('a1', { role: 'researcher' }),
      ],
      activeRowIndex: -1,
    });
    expect(led.stallCount).toBe(0);
    expect(led.stalled).toBe(false);
  });

  it('STALL_LIMIT is 2 (Magentic-One threshold)', () => {
    expect(STALL_LIMIT).toBe(2);
  });
});
