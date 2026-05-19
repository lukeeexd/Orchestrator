import fs from 'node:fs';

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

