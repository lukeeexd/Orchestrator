import { describe, it, expect } from 'vitest';
import { buildBranchName, slugify } from '../../src/main/git';

describe('git.slugify', () => {
  it('lowercases ASCII, collapses non-alphanumerics to single dashes', () => {
    expect(slugify('Fix the Bar')).toBe('fix-the-bar');
    expect(slugify('foo___bar///baz')).toBe('foo-bar-baz');
  });
  it('trims leading and trailing dashes', () => {
    expect(slugify('  hello world  ')).toBe('hello-world');
    expect(slugify('--leading--trailing--')).toBe('leading-trailing');
  });
  it('drops non-ASCII characters', () => {
    // Unicode "é" decomposes to "e" + combining accent; both get dropped
    // except the plain "e", which leaves a usable slug. Pure non-ASCII
    // collapses to empty.
    expect(slugify('café au lait')).toBe('cafe-au-lait');
    expect(slugify('日本語')).toBe('');
  });
  it('truncates to the given max length without leaving a trailing dash', () => {
    // The 12-char slice would land on a dash inside "long-task"; the
    // tail-strip should remove it.
    expect(slugify('a-very-long-task-description', 12)).toBe('a-very-long');
  });
  it('returns empty for empty / whitespace / all-punctuation input', () => {
    expect(slugify('')).toBe('');
    expect(slugify('   ')).toBe('');
    expect(slugify('!!!')).toBe('');
  });
});

describe('git.buildBranchName', () => {
  it('composes orchestrator/<short>-<slug>', () => {
    const branch = buildBranchName(
      '4d5e6f7a-1b2c-3d4e-5f6a-7b8c9d0e1f2a',
      'Fix the foo',
    );
    expect(branch).toBe('orchestrator/4d5e6f7a-fix-the-foo');
  });
  it('strips dashes from the plan id when slicing', () => {
    // The id has dashes; we want the FIRST 8 hex chars, not 8 chars
    // including a dash separator that would leave the slug ambiguous.
    const branch = buildBranchName('abcd-efgh-ijkl-mnop', 'bar');
    expect(branch).toBe('orchestrator/abcdefgh-bar');
  });
  it('omits the slug suffix when the source slugifies to empty', () => {
    const branch = buildBranchName('12345678abc', '日本語');
    expect(branch).toBe('orchestrator/12345678');
  });
  it('falls back to "plan" when the id itself is empty', () => {
    expect(buildBranchName('', 'foo')).toBe('orchestrator/plan-foo');
  });
});
