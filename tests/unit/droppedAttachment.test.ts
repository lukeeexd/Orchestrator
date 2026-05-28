import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';

// security/attachments transitively imports `../attachments` (which
// imports `electron`) and `../projects` (which imports `./db`).
// `isDroppedAttachmentSafe` doesn't touch either — it's pure — but
// the import graph executes module-load side effects. Mock both so
// the test loads cleanly.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/__unused__' },
}));
vi.mock('../../src/main/projects', () => ({
  listProjects: () => [],
}));
vi.mock('../../src/main/db', () => ({
  getDb: () => {
    throw new Error('db not used in this test');
  },
  scheduleSave: vi.fn(),
  isDbOpen: () => false,
}));

import { isDroppedAttachmentSafe } from '../../src/main/security/attachments';

/**
 * Unit-level coverage for the pure policy half of the
 * `allowDroppedAttachment` guard (R-Vuln1-2026-05-28). The
 * fs-touching wrapper isn't tested here — it needs realpath + a
 * mocked project list — but every branch the audit's exploit
 * scenario exercises is reachable through the pure function.
 *
 * `path.resolve` is used inside the policy via `path.relative`, so
 * we feed it already-absolute paths to keep the test platform-
 * agnostic.
 */

const ws =
  process.platform === 'win32'
    ? 'C:\\workspace\\project-a'
    : '/workspace/project-a';

const join = (root: string, rel: string): string =>
  path.normalize(`${root}${path.sep}${rel}`);

describe('isDroppedAttachmentSafe', () => {
  it('allows a text file inside the project workspace', () => {
    const r = isDroppedAttachmentSafe(join(ws, 'src/index.ts'), [ws]);
    expect(r.ok).toBe(true);
  });

  it('allows an image file inside the workspace', () => {
    const r = isDroppedAttachmentSafe(join(ws, 'docs/screenshot.png'), [ws]);
    expect(r.ok).toBe(true);
  });

  it('rejects paths outside every configured workspace', () => {
    const home =
      process.platform === 'win32'
        ? 'C:\\Users\\luke\\.claude\\settings.json'
        : '/home/luke/.claude/settings.json';
    const r = isDroppedAttachmentSafe(home, [ws]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/outside the project workspace/i);
    }
  });

  it('rejects parent-traversal paths even when the prefix matches a workspace string', () => {
    // path.relative correctly identifies traversal regardless of how
    // the input string looks — feed it the kind of literal a naive
    // startsWith check would let slip and confirm we don't.
    const sneaky =
      process.platform === 'win32'
        ? 'C:\\workspace\\project-a\\..\\..\\Users\\luke\\.aws\\credentials.json'
        : '/workspace/project-a/../../home/luke/.aws/credentials.json';
    const resolved = path.resolve(sneaky);
    const r = isDroppedAttachmentSafe(resolved, [ws]);
    expect(r.ok).toBe(false);
  });

  it('rejects extensions outside the attachment allow-list', () => {
    const bin = join(ws, 'build/cred.pem');
    const r = isDroppedAttachmentSafe(bin, [ws]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/extension/i);
    }
  });

  it('rejects extensionless files', () => {
    const noext = join(ws, 'no_ext_file');
    const r = isDroppedAttachmentSafe(noext, [ws]);
    expect(r.ok).toBe(false);
  });

  it('rejects when no project workspaces are configured (closes the empty-set hole)', () => {
    // Without an explicit empty-set check the for-loop would just
    // fall through and the function would return "outside the
    // project workspace" — semantically OK but the dedicated
    // message is friendlier for the no-projects-yet user.
    const r = isDroppedAttachmentSafe(join(ws, 'foo.md'), []);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/no configured project workspace/i);
    }
  });

  it('honours multiple workspace roots — match against any is enough', () => {
    const wsB =
      process.platform === 'win32'
        ? 'C:\\workspace\\project-b'
        : '/workspace/project-b';
    const r = isDroppedAttachmentSafe(join(wsB, 'README.md'), [ws, wsB]);
    expect(r.ok).toBe(true);
  });
});
