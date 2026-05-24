import { describe, it, expect, vi } from 'vitest';

// secrets.ts pulls in db.ts which imports `app` from electron. The
// pure exports (NAME_PATTERN + assertValidName) don't touch the DB
// or electron, but the module evaluation still resolves the import.
// Mock electron with stubs so vitest doesn't try to pull the Electron
// binary at test time.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
}));

import { assertValidName, NAME_PATTERN } from '../../src/main/secrets';

describe('NAME_PATTERN', () => {
  it('accepts conventional env var names', () => {
    expect(NAME_PATTERN.test('DATABASE_URL')).toBe(true);
    expect(NAME_PATTERN.test('GH_TOKEN')).toBe(true);
    expect(NAME_PATTERN.test('STRIPE_SECRET_KEY')).toBe(true);
    expect(NAME_PATTERN.test('X')).toBe(true);
    expect(NAME_PATTERN.test('A_B_C_1_2_3')).toBe(true);
  });

  it('rejects names starting with a digit', () => {
    expect(NAME_PATTERN.test('1_TOKEN')).toBe(false);
  });

  it('rejects lowercase letters', () => {
    expect(NAME_PATTERN.test('database_url')).toBe(false);
    expect(NAME_PATTERN.test('Database_Url')).toBe(false);
  });

  it('rejects dashes / spaces / dots', () => {
    expect(NAME_PATTERN.test('DATA-BASE')).toBe(false);
    expect(NAME_PATTERN.test('DATA BASE')).toBe(false);
    expect(NAME_PATTERN.test('DATA.BASE')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(NAME_PATTERN.test('')).toBe(false);
  });

  it('rejects names over 63 chars', () => {
    expect(NAME_PATTERN.test('A'.repeat(63))).toBe(true);
    expect(NAME_PATTERN.test('A'.repeat(64))).toBe(false);
  });
});

describe('assertValidName', () => {
  it('throws with a helpful message on invalid names', () => {
    expect(() => assertValidName('lower_case')).toThrow(/env-var shape/);
    expect(() => assertValidName('1_LEADING_DIGIT')).toThrow();
    expect(() => assertValidName('')).toThrow();
  });

  it('accepts valid names without throwing', () => {
    expect(() => assertValidName('DATABASE_URL')).not.toThrow();
  });
});
