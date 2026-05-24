import { describe, it, expect } from 'vitest';
import { computeLogLineKey } from '../../src/shared/logNotes';
import type { LogLine } from '../../src/shared/types';

const line = (overrides: Partial<LogLine> = {}): LogLine => ({
  ts: '2026-05-24T20:00:00Z',
  kind: 'thought',
  msg: 'thinking about it',
  ...overrides,
});

describe('computeLogLineKey', () => {
  it('returns a deterministic 8-char hex string', () => {
    const k = computeLogLineKey(line());
    expect(k).toMatch(/^[0-9a-f]{8}$/);
    expect(computeLogLineKey(line())).toBe(k);
  });

  it('gives different keys for different ts', () => {
    const a = computeLogLineKey(line({ ts: '2026-05-24T20:00:00Z' }));
    const b = computeLogLineKey(line({ ts: '2026-05-24T20:00:01Z' }));
    expect(a).not.toBe(b);
  });

  it('gives different keys for different kind', () => {
    const a = computeLogLineKey(line({ kind: 'thought' }));
    const b = computeLogLineKey(line({ kind: 'tool' }));
    expect(a).not.toBe(b);
  });

  it('gives different keys for different msg text', () => {
    const a = computeLogLineKey(line({ msg: 'a' }));
    const b = computeLogLineKey(line({ msg: 'b' }));
    expect(a).not.toBe(b);
  });

  it('hashes a tool call by fn + sorted args, independent of arg order', () => {
    const a = computeLogLineKey(
      line({
        kind: 'tool',
        msg: {
          fn: 'Read',
          args: [
            { k: 'file_path', v: '/foo' },
            { k: 'offset', v: '0' },
          ],
        },
      }),
    );
    const b = computeLogLineKey(
      line({
        kind: 'tool',
        msg: {
          fn: 'Read',
          args: [
            { k: 'offset', v: '0' },
            { k: 'file_path', v: '/foo' },
          ],
        },
      }),
    );
    expect(a).toBe(b);
  });

  it('differs across fn names', () => {
    const a = computeLogLineKey(
      line({ kind: 'tool', msg: { fn: 'Read', args: [] } }),
    );
    const b = computeLogLineKey(
      line({ kind: 'tool', msg: { fn: 'Write', args: [] } }),
    );
    expect(a).not.toBe(b);
  });

  it('differs when an arg value changes', () => {
    const a = computeLogLineKey(
      line({
        kind: 'tool',
        msg: { fn: 'Read', args: [{ k: 'file_path', v: '/foo' }] },
      }),
    );
    const b = computeLogLineKey(
      line({
        kind: 'tool',
        msg: { fn: 'Read', args: [{ k: 'file_path', v: '/bar' }] },
      }),
    );
    expect(a).not.toBe(b);
  });
});
