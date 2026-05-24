import { describe, it, expect } from 'vitest';
import { diffPlans } from '../../src/renderer/lib/planDiff';
import type { PlanRow } from '../../src/shared/types';

const row = (i: number, role: PlanRow['role'], name: string, task: string): PlanRow => ({
  i,
  role,
  name,
  task,
});

describe('diffPlans — added rows', () => {
  it('marks rows present in current but not prev as added', () => {
    const prev = [row(1, 'coder', 'alpha', 'do x')];
    const current = [
      row(1, 'coder', 'alpha', 'do x'),
      row(2, 'qa', 'beta', 'test x'),
    ];
    const d = diffPlans(current, prev);
    expect(d.summary).toEqual({ added: 1, modified: 0, removed: 0, unchanged: 1 });
    expect(d.rows[0].status).toBe('unchanged');
    expect(d.rows[1].status).toBe('added');
  });
});

describe('diffPlans — removed rows', () => {
  it('captures prev rows not present in current', () => {
    const prev = [
      row(1, 'coder', 'alpha', 'do x'),
      row(2, 'qa', 'beta', 'test x'),
    ];
    const current = [row(1, 'coder', 'alpha', 'do x')];
    const d = diffPlans(current, prev);
    expect(d.summary.removed).toBe(1);
    expect(d.removed[0].name).toBe('beta');
  });
});

describe('diffPlans — modified rows', () => {
  it('detects task changes on matched (role, name) pairs', () => {
    const prev = [row(1, 'coder', 'alpha', 'do x')];
    const current = [row(1, 'coder', 'alpha', 'do x and y')];
    const d = diffPlans(current, prev);
    expect(d.summary).toEqual({ added: 0, modified: 1, removed: 0, unchanged: 0 });
    expect(d.rows[0].status).toBe('modified');
    expect(d.rows[0].prevTask).toBe('do x');
  });

  it('does NOT match across roles even when name is identical', () => {
    const prev = [row(1, 'coder', 'alpha', 'do x')];
    const current = [row(1, 'qa', 'alpha', 'do x')];
    const d = diffPlans(current, prev);
    expect(d.summary).toEqual({ added: 1, modified: 0, removed: 1, unchanged: 0 });
  });
});

describe('diffPlans — edge cases', () => {
  it('handles empty prev (first plan ever)', () => {
    const current = [row(1, 'coder', 'alpha', 'do x'), row(2, 'qa', 'beta', 'test')];
    const d = diffPlans(current, []);
    expect(d.summary).toEqual({ added: 2, modified: 0, removed: 0, unchanged: 0 });
  });

  it('handles empty current (plan wiped)', () => {
    const prev = [row(1, 'coder', 'alpha', 'do x')];
    const d = diffPlans([], prev);
    expect(d.summary).toEqual({ added: 0, modified: 0, removed: 1, unchanged: 0 });
  });

  it('handles duplicate (role, name) pairs greedily in encounter order', () => {
    const prev = [
      row(1, 'coder', 'alpha', 'task A'),
      row(2, 'coder', 'alpha', 'task B'),
    ];
    const current = [
      row(1, 'coder', 'alpha', 'task A modified'),
      row(2, 'coder', 'alpha', 'task B'),
    ];
    const d = diffPlans(current, prev);
    // First-current pairs with first-prev (task A → modified);
    // second-current pairs with second-prev (task B → unchanged).
    expect(d.rows[0].status).toBe('modified');
    expect(d.rows[0].prevTask).toBe('task A');
    expect(d.rows[1].status).toBe('unchanged');
  });

  it('ignores `i` field differences when names match', () => {
    const prev = [row(5, 'coder', 'alpha', 'do x')];
    const current = [row(1, 'coder', 'alpha', 'do x')];
    const d = diffPlans(current, prev);
    expect(d.summary.unchanged).toBe(1);
  });
});
