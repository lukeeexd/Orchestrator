import { describe, it, expect, vi } from 'vitest';

// secondaryUpdater imports electron at module scope (`import { app,
// BrowserWindow } from 'electron'`). The pure isNewer function never
// touches them, but vitest still has to resolve the module — so mock
// electron with stubs.
vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.0.0' },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { isNewer } from '../../src/main/secondaryUpdater';

describe('isNewer — 3-part versions', () => {
  it('returns true when candidate > current', () => {
    expect(isNewer('0.15.1', '0.15.0')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.16.0', '0.15.9')).toBe(true);
  });

  it('returns false when candidate <= current', () => {
    expect(isNewer('0.15.0', '0.15.1')).toBe(false);
    expect(isNewer('0.15.0', '0.15.0')).toBe(false);
    expect(isNewer('0.14.99', '0.15.0')).toBe(false);
  });
});

describe('isNewer — 4-part versions (R-A6 regression)', () => {
  it('detects a 4-part hotfix as newer than its 3-part predecessor', () => {
    // R-A6 — the original 3-segment-only loop returned false here.
    expect(isNewer('0.15.1.1', '0.15.1')).toBe(true);
  });

  it('detects newer 4-part vs 4-part', () => {
    expect(isNewer('0.15.1.2', '0.15.1.1')).toBe(true);
    expect(isNewer('0.15.1.1', '0.15.1.2')).toBe(false);
  });

  it('treats 4-part equal as not newer', () => {
    expect(isNewer('0.15.1.0', '0.15.1.0')).toBe(false);
  });

  it('still returns false for 3-part candidate equal to the 4-part-with-trailing-zero', () => {
    // 0.15.1 == 0.15.1.0 semantically.
    expect(isNewer('0.15.1', '0.15.1.0')).toBe(false);
  });
});

describe('isNewer — malformed input', () => {
  it('returns false when either side has fewer than three segments', () => {
    expect(isNewer('1.0', '0.0.0')).toBe(false);
    expect(isNewer('0.0.0', '1.0')).toBe(false);
    expect(isNewer('', '0.0.0')).toBe(false);
  });

  it('returns false when the FIRST differing segment is NaN', () => {
    // The differing segment is the third one; parseInt('x', 10) is NaN,
    // so the NaN guard fires before the comparison.
    expect(isNewer('1.0.x', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0', '1.0.x')).toBe(false);
  });
});
