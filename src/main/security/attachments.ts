import fs from 'node:fs';
import path from 'node:path';
import { classifyAttachmentPath } from '../attachments';
import { listProjects } from '../projects';

/**
 * Per-session allow-list of attachment paths the user actually
 * surfaced via a user-gesture IPC call (file picker, paste, drag-
 * drop). Anything not in the set is rejected when the runner tries
 * to read it.
 *
 * Why: `readAttachmentAsDataUrl` and `prepareAttachments` both
 * read arbitrary file paths off disk. Without an allow-list, a
 * compromised renderer can ask the main process to read any local
 * file (image or text) and either render it in the UI or inline it
 * into an LLM prompt — i.e. exfiltrate.
 *
 * Realpath-resolved on insert and on check so a junction or symlink
 * sneaking into %TEMP% can't redirect a read after the user picked
 * the original file. Renderer-supplied paths that don't resolve to
 * something already in the set are rejected.
 *
 * Cleared on process exit (in-memory set, no persistence). The user
 * picking the same file in a new app session just re-populates it.
 */

const allowed = new Set<string>();

function key(absPath: string): string {
  return process.platform === 'win32'
    ? absPath.toLowerCase()
    : absPath;
}

/**
 * Resolve symlinks/junctions and add to the allow-list. Safe to
 * call repeatedly with the same path. Throws on resolution failure
 * so the caller can propagate "file gone / unreadable" to the
 * user — silently dropping it would let a renderer probe paths
 * without feedback.
 */
export function allowAttachment(absPath: string): string {
  const real = fs.realpathSync(absPath);
  const k = key(real);
  allowed.add(k);
  return real;
}

/**
 * Returns true if `absPath` (after realpath resolution) is in the
 * allow-list. Used by the runner before reading the file and by
 * `readAttachmentAsDataUrl` before exposing it to the renderer.
 *
 * Returns false on any resolution error — the read should fail
 * closed.
 */
export function isAttachmentAllowed(absPath: string): boolean {
  try {
    const real = fs.realpathSync(absPath);
    return allowed.has(key(real));
  } catch {
    return false;
  }
}

/**
 * Pure policy: is `realPath` an attachment shape we accept from a
 * renderer drag-drop gesture? Used by `allowDroppedAttachment` below
 * and exercised directly by unit tests (no fs/realpath needed at
 * test time). Returns `{ ok: true }` on pass; `{ ok: false, reason }`
 * with a short human-readable reason otherwise.
 *
 * The policy gates BOTH halves of the renderer-trust gap that the
 * 2026-05-28 audit named:
 *   1. Extension must classify to something the inline-prompt
 *      pipeline knows how to handle (text/image/document). Stops
 *      arbitrary `.key` / `.pem` / extensionless reads.
 *   2. RealPath must live under one of the configured project
 *      workspaces. Stops `~/.claude/settings.json`,
 *      `~/.aws/credentials`, `<userData>/...`, and other off-tree
 *      exfil targets. Files outside any workspace can still be
 *      attached — they just need to go through the native file
 *      picker (server-minted path), not drag-drop.
 */
export function isDroppedAttachmentSafe(
  realPath: string,
  workspaceRoots: string[],
): { ok: true } | { ok: false; reason: string } {
  if (classifyAttachmentPath(realPath) === 'unsupported') {
    return { ok: false, reason: 'extension not in attachment allow-list' };
  }
  if (workspaceRoots.length === 0) {
    return {
      ok: false,
      reason: 'no configured project workspace — use the file picker instead',
    };
  }
  for (const root of workspaceRoots) {
    if (isPathUnder(realPath, root)) return { ok: true };
  }
  return {
    ok: false,
    reason: 'path is outside the project workspace — use the file picker instead',
  };
}

/** True iff `child` is a path inside `parent` (both already realpath'd). */
function isPathUnder(child: string, parent: string): boolean {
  // path.relative + isAbsolute / `..`-prefix check matches Node's
  // own containment idiom; case folding is implicit on win32
  // because realpath returns canonical case there.
  const rel = path.relative(parent, child);
  if (rel.length === 0) return false; // exact match isn't a file
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

function realPathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * R-Vuln1-2026-05-28: variant of `allowAttachment` for paths supplied
 * by the renderer through drag-drop. Applies `isDroppedAttachmentSafe`
 * against every configured project workspace before promoting the
 * path into the allow-list. Throws on policy failure so the IPC
 * handler can skip the path quietly; the chip will surface as
 * `ok:false` downstream via `describeAttachments`.
 *
 * The trusted paths (file-picker dialog return value, paste-to-temp
 * write target) keep using `allowAttachment` directly — those are
 * server-minted and shouldn't be re-gated against the workspace.
 */
export function allowDroppedAttachment(absPath: string): string {
  const real = fs.realpathSync(absPath);
  const workspaces: string[] = [];
  for (const proj of listProjects()) {
    if (!proj.workspace) continue;
    const wsReal = realPathOrNull(proj.workspace);
    if (wsReal !== null) workspaces.push(wsReal);
  }
  const verdict = isDroppedAttachmentSafe(real, workspaces);
  if (!verdict.ok) {
    throw new Error(verdict.reason);
  }
  const k = key(real);
  allowed.add(k);
  return real;
}

