import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * R-Vuln4-2026-05-28: `readMarkdownFile` now realpaths BEFORE checking
 * the extension. Pre-fix order was extension-check-then-realpath, so a
 * symlink named `foo.md` pointing at `~/.ssh/config` passed the
 * link-name extension gate and then silently followed to the target.
 *
 * The function imports only `node:fs` and `node:path`, so no mocking
 * is needed — we exercise the behavior against a real temp dir.
 */

import { readMarkdownFile } from '../../src/main/markdownBrowser';

const mkTmp = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-md-'));

describe('readMarkdownFile — order-of-operations (R-Vuln4)', () => {
  it('reports the realpath failure first, not the extension check', () => {
    // For a non-existent `.txt` path, the pre-fix code threw
    // "Refusing to read non-markdown file" (extension check ran
    // before realpath). Post-fix, realpath runs first, so the user
    // sees "Cannot read file" — the differentiating signal that the
    // order is correct.
    const missing = path.join(os.tmpdir(), 'definitely-missing-12345.txt');
    expect(() => readMarkdownFile(missing)).toThrow(/cannot read file/i);
  });

  it('still rejects existing non-markdown files', () => {
    const dir = mkTmp();
    try {
      const txt = path.join(dir, 'not-markdown.txt');
      fs.writeFileSync(txt, 'plain text');
      expect(() => readMarkdownFile(txt)).toThrow(
        /refusing to read non-markdown/i,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a real markdown file successfully', () => {
    const dir = mkTmp();
    try {
      const md = path.join(dir, 'note.md');
      fs.writeFileSync(md, '# hi\n');
      const r = readMarkdownFile(md);
      expect(r.content).toBe('# hi\n');
      expect(r.truncated).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a symlink whose .md name resolves to a non-markdown target', () => {
    // Real symlink test. Skip on platforms / permission levels where
    // creating a file symlink fails — Windows without developer mode
    // / admin returns EPERM. The behavior under test is platform-
    // independent; running this on any host that supports symlinks
    // is enough to assert the fix.
    const dir = mkTmp();
    try {
      const target = path.join(dir, 'ssh-config-lookalike.txt');
      fs.writeFileSync(target, 'Host github.com\n  IdentityFile ~/.ssh/id_ed25519\n');
      const link = path.join(dir, 'innocent.md');
      try {
        fs.symlinkSync(target, link, 'file');
      } catch (err) {
        if (
          err instanceof Error &&
          /EPERM|ENOSYS|operation not permitted/i.test(err.message)
        ) {
          // Symlink permission unavailable — skip without failure.
          return;
        }
        throw err;
      }
      expect(() => readMarkdownFile(link)).toThrow(
        /refusing to read non-markdown/i,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
