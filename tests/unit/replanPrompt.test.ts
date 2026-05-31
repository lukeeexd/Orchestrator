import { describe, it, expect } from 'vitest';
import { buildReplanPrompt } from '../../src/main/director/prompt';
import type { PlanRow } from '../../src/shared/types';

function row(i: number, over: Partial<PlanRow> = {}): PlanRow {
  return { i, role: 'coder', name: `coder-${i}`, task: `task ${i}`, ...over };
}

describe('buildReplanPrompt', () => {
  it('includes the stall reason, completed digest, and remaining rows', () => {
    const out = buildReplanPrompt({
      stallReason: '2 consecutive steps made no measurable progress.',
      completedDigest: '## Prior steps in this run\n- @coder-1 (coder): 2 files',
      remainingRows: [row(3, { role: 'qa', name: 'qa-1' }), row(4)],
      budgetRemaining: 25,
    });
    expect(out).toContain('AUTO-REPLAN');
    expect(out).toContain('2 consecutive steps made no measurable progress.');
    expect(out).toContain('@coder-1 (coder): 2 files');
    expect(out).toContain('3. qa qa-1 — task 3');
    expect(out).toContain('4. coder coder-4 — task 4');
    // Core instruction: revised plan, do not re-add completed work.
    expect(out).toContain('REVISED orchestrator-plan');
    expect(out).toContain('do NOT re-add');
  });

  it('handles no remaining rows', () => {
    const out = buildReplanPrompt({
      stallReason: 'stalled',
      completedDigest: 'something',
      remainingRows: [],
      budgetRemaining: 10,
    });
    expect(out).toContain('every planned step was attempted');
  });

  it('falls back when there is no completed digest', () => {
    const out = buildReplanPrompt({
      stallReason: 'stalled',
      completedDigest: null,
      remainingRows: [row(1)],
      budgetRemaining: 10,
    });
    expect(out).toContain('No measurable progress was recorded');
  });

  it('states a finite spawn cap, or none when unlimited', () => {
    const capped = buildReplanPrompt({
      stallReason: 's',
      completedDigest: null,
      remainingRows: [row(1)],
      budgetRemaining: 25,
    });
    expect(capped).toContain('within 25 agent(s)');

    const unlimited = buildReplanPrompt({
      stallReason: 's',
      completedDigest: null,
      remainingRows: [row(1)],
      budgetRemaining: Infinity,
    });
    expect(unlimited).toContain('No spawn cap is set');
  });
});
