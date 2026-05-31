import { describe, it, expect } from 'vitest';
import { formatRunDigest } from '../../src/main/runDigest';
import type { BlackboardEntry } from '../../src/shared/types';

function entry(over: Partial<BlackboardEntry> = {}): BlackboardEntry {
  return {
    id: over.id ?? 'e',
    projectId: 'p',
    runId: 'r',
    agentId: over.agentId ?? 'a',
    agentName: over.agentName ?? 'coder-01',
    role: over.role ?? 'coder',
    ts: over.ts ?? 0,
    summary: over.summary ?? '',
    filesTouched: over.filesTouched ?? [],
    testsRun: over.testsRun ?? null,
    errors: over.errors ?? [],
    todos: over.todos ?? [],
  };
}

describe('formatRunDigest', () => {
  it('returns empty string for no entries', () => {
    expect(formatRunDigest([])).toBe('');
  });

  it('emits a header plus one line per entry with facts + summary', () => {
    const out = formatRunDigest([
      entry({
        agentName: 'coder-01',
        role: 'coder',
        filesTouched: ['src/a.ts', 'src/b.ts'],
        testsRun: { pass: 5, fail: 0, skip: 1 },
        summary: 'Implemented the parser.',
      }),
    ]);
    expect(out).toContain('## Prior steps in this run');
    expect(out).toContain('@coder-01 (coder):');
    expect(out).toContain('2 files (src/a.ts, src/b.ts)');
    expect(out).toContain('tests 5✓/0✗');
    expect(out).toContain('Implemented the parser.');
  });

  it('renders "no files" and omits tests/errors when absent (read-only step)', () => {
    const out = formatRunDigest([
      entry({ agentName: 'research-01', role: 'researcher', summary: 'Surveyed the API.' }),
    ]);
    expect(out).toContain('@research-01 (researcher): no files');
    // No test fact (✓/✗ glyphs) and no error count on a clean read-only step.
    // (The header prose mentions the word "tests", so assert on the glyphs.)
    expect(out).not.toContain('✓');
    expect(out).not.toContain('✗');
    expect(out).not.toContain('error');
  });

  it('collapses a long file list to the first 5 + count', () => {
    const files = Array.from({ length: 9 }, (_, i) => `f${i}.ts`);
    const out = formatRunDigest([entry({ filesTouched: files })]);
    expect(out).toContain('9 files (f0.ts, f1.ts, f2.ts, f3.ts, f4.ts, …)');
    expect(out).not.toContain('f5.ts');
  });

  it('truncates an over-long summary with an ellipsis', () => {
    const long = 'x'.repeat(400);
    const out = formatRunDigest([entry({ summary: long })]);
    expect(out).toContain('…');
    // The 400-char summary must not appear in full.
    expect(out).not.toContain(long);
  });

  it('secret-scrubs the block (summaries can echo tokens)', () => {
    const out = formatRunDigest([
      entry({ summary: 'wired the key sk-ant-abcdefghijklmnopqrstuvwxyz0123' }),
    ]);
    expect(out).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
    expect(out).toContain('[REDACTED:anthropic]');
  });

  it('strips orchestrator-* fences from a summary (R-A8) — even with newlines, before truncate collapses them', () => {
    const summary =
      'Done.\n```orchestrator-plan\n{"rows":[{"role":"coder"}]}\n```\nWired it up.';
    const out = formatRunDigest([entry({ summary })]);
    expect(out).not.toContain('orchestrator-plan');
    expect(out).toContain('[orchestrator-fence redacted]');
  });

  it('shows only the most recent N entries (window), oldest-first within it', () => {
    const entries = Array.from({ length: 11 }, (_, i) =>
      entry({ id: `e${i}`, agentName: `coder-${i}`, ts: i }),
    );
    const out = formatRunDigest(entries);
    // Window is the last 8 (coder-3 .. coder-10); coder-0..2 dropped.
    expect(out).not.toContain('@coder-0 ');
    expect(out).not.toContain('@coder-2 ');
    expect(out).toContain('@coder-3 ');
    expect(out).toContain('@coder-10 ');
    // Within the window, oldest-first: coder-3 appears before coder-10.
    expect(out.indexOf('@coder-3 ')).toBeLessThan(out.indexOf('@coder-10 '));
  });

  it('hard-caps the total length for a chatty run', () => {
    const entries = Array.from({ length: 8 }, (_, i) =>
      entry({ id: `e${i}`, agentName: `coder-${i}`, summary: 'y'.repeat(159) }),
    );
    const out = formatRunDigest(entries);
    // Total must stay near the cap (2500) + the omission marker, not 8×full.
    expect(out.length).toBeLessThan(2600);
  });
});
