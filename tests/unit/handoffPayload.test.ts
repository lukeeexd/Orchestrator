import { describe, it, expect } from 'vitest';
import { buildHandoffPayload } from '../../src/main/agents/handoffPayload';
import type { Agent, LogLine } from '../../src/shared/types';

function makeAgent(log: LogLine[], workspace = '/work'): Agent {
  // buildHandoffPayload only reads .log and .workspace from the agent.
  // Cast away the rest of the Agent surface for test brevity.
  return { log, workspace } as unknown as Agent;
}

const tool = (fn: string, args: Record<string, string>): LogLine => ({
  ts: '2026-05-22T00:00:00Z',
  kind: 'tool',
  msg: {
    fn,
    args: Object.entries(args).map(([k, v]) => ({ k, v })),
  },
});

const text = (kind: LogLine['kind'], msg: string): LogLine => ({
  ts: '2026-05-22T00:00:00Z',
  kind,
  msg,
});

describe('buildHandoffPayload — files_touched', () => {
  it('captures Write/Edit/MultiEdit/NotebookEdit paths and dedups', () => {
    const log: LogLine[] = [
      tool('Write', { file_path: '/work/a.ts' }),
      tool('Edit', { file_path: '/work/a.ts' }),
      tool('MultiEdit', { file_path: '/work/sub/b.ts' }),
      tool('NotebookEdit', { notebook_path: '/work/c.ipynb' }),
      tool('Read', { file_path: '/work/d.ts' }),
    ];
    const payload = buildHandoffPayload(makeAgent(log), 'done');
    expect(payload.files_touched.sort()).toEqual(['a.ts', 'c.ipynb', 'sub/b.ts']);
  });

  it('keeps outside-workspace paths absolute', () => {
    const log: LogLine[] = [tool('Write', { file_path: '/other/somewhere.ts' })];
    const payload = buildHandoffPayload(makeAgent(log, '/work'), 'done');
    expect(payload.files_touched).toEqual(['/other/somewhere.ts']);
  });
});

describe('buildHandoffPayload — tests_run parsers', () => {
  it('parses pytest "N passed, M failed, K skipped"', () => {
    const log: LogLine[] = [text('result', '12 passed, 3 failed, 1 skipped in 4.2s')];
    const payload = buildHandoffPayload(makeAgent(log), 'done');
    expect(payload.tests_run).toEqual({ pass: 12, fail: 3, skip: 1 });
  });

  it('parses jest "Tests: X passed, Y failed, Z total"', () => {
    const log: LogLine[] = [
      text('result', 'Tests:       3 failed, 12 passed, 15 total'),
    ];
    const payload = buildHandoffPayload(makeAgent(log), 'done');
    expect(payload.tests_run?.pass).toBe(12);
    expect(payload.tests_run?.fail).toBe(3);
  });

  it('prefers the larger tally when multiple runs appear', () => {
    const log: LogLine[] = [
      text('result', '2 passed in 0.1s'),
      text('result', '50 passed, 0 failed, 0 skipped'),
    ];
    const payload = buildHandoffPayload(makeAgent(log), 'done');
    expect(payload.tests_run?.pass).toBe(50);
  });

  it('returns null when no recognised pattern matches', () => {
    const log: LogLine[] = [text('result', 'all done')];
    const payload = buildHandoffPayload(makeAgent(log), 'done');
    expect(payload.tests_run).toBeNull();
  });
});

describe('buildHandoffPayload — todos and errors', () => {
  it('pulls TODO / next-step / follow-up lines from thought log', () => {
    const log: LogLine[] = [
      text('thought', '- TODO: wire up the cache\nNext step: ship it'),
      text('thought', 'Follow-up: write tests'),
    ];
    const payload = buildHandoffPayload(makeAgent(log), 'done');
    expect(payload.todos.length).toBeGreaterThanOrEqual(2);
    expect(payload.todos.join(' ')).toMatch(/TODO/i);
  });

  it('caps todos at MAX_TODOS=5', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `TODO: item ${i}`).join('\n');
    const log: LogLine[] = [text('thought', lines)];
    const payload = buildHandoffPayload(makeAgent(log), 'done');
    expect(payload.todos.length).toBe(5);
  });

  it('extracts first line of each error / warn entry', () => {
    const log: LogLine[] = [
      text('error', 'ENOENT: no such file\n  at fs.openSync'),
      text('warn', 'Deprecation: x will go away'),
    ];
    const payload = buildHandoffPayload(makeAgent(log), 'done');
    expect(payload.errors).toEqual([
      'ENOENT: no such file',
      'Deprecation: x will go away',
    ]);
  });
});

describe('buildHandoffPayload — summary passthrough', () => {
  it('returns the supplied summary verbatim', () => {
    const payload = buildHandoffPayload(makeAgent([]), 'hello world');
    expect(payload.summary).toBe('hello world');
  });
});
