import { describe, it, expect, vi } from 'vitest';

/**
 * R-Vuln3-2026-05-28: `writeSkill` validates `key` against the closed
 * SkillKey set before path.join — a traversed key would otherwise
 * escape the workspace's `.orchestrator/skills/` directory and write
 * a `.md` file anywhere reachable. The pure-policy test below
 * exercises only the rejection arm; the accept path needs a real
 * project + workspace and is covered indirectly by the existing
 * skills-rail integration.
 *
 * The module imports `electron` (transitively via `./projects` →
 * `./db`) and our defaults loader; mock both so the rejection check
 * runs without touching disk or the app environment.
 */

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/__unused__' },
}));
vi.mock('../../src/main/projects', () => ({
  getProject: () => null,
}));
vi.mock('../../src/main/db', () => ({
  getDb: () => {
    throw new Error('db not used in this test');
  },
  isDbOpen: () => false,
}));
vi.mock('../../src/main/claudeCodeMemory', () => ({
  loadClaudeCodeMemorySection: () => '',
}));

import { writeSkill } from '../../src/main/skills';

describe('writeSkill — key validation (R-Vuln3)', () => {
  it('rejects parent-traversal keys before any fs touch', () => {
    expect(() =>
      writeSkill('any-project', '../../../CLAUDE' as never, 'payload'),
    ).toThrow(/invalid skill key/i);
  });

  it('rejects keys outside the closed SkillKey set', () => {
    expect(() =>
      writeSkill('any-project', 'arbitrary' as never, 'payload'),
    ).toThrow(/invalid skill key/i);
  });

  it('rejects empty-string key', () => {
    expect(() => writeSkill('any-project', '' as never, 'payload')).toThrow(
      /invalid skill key/i,
    );
  });

  it('rejects directory separators in key', () => {
    expect(() =>
      writeSkill('any-project', 'foo/bar' as never, 'payload'),
    ).toThrow(/invalid skill key/i);
    expect(() =>
      writeSkill('any-project', 'foo\\bar' as never, 'payload'),
    ).toThrow(/invalid skill key/i);
  });

  it('rejects close-but-wrong keys (uppercase variants)', () => {
    expect(() => writeSkill('any-project', 'Coder' as never, '...')).toThrow(
      /invalid skill key/i,
    );
  });

  it('passes the key gate for a valid SkillKey (then fails on missing project)', () => {
    // 'coder' is in ALL_SKILL_KEYS; the next branch — `getProject` —
    // returns null in this test's mock, so we expect the workspace
    // error rather than the invalid-key error. That confirms the
    // gate doesn't mistakenly reject legitimate keys.
    expect(() => writeSkill('any-project', 'coder', 'payload')).toThrow(
      /no workspace folder/i,
    );
  });
});
