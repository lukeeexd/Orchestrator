/**
 * Shared private helpers for the marketplace modules. Not re-exported
 * from the barrel — these are implementation details of the marketplace
 * layer, not part of its public surface.
 */

/**
 * Sanitize an arbitrary id (typically a GitHub `owner/repo` slug) into
 * a filesystem-safe directory name. Two ids that differ only in
 * non-alphanumeric characters can collide here — fine for our case
 * since source ids are repo slugs that already follow GitHub's
 * naming rules.
 */
export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9.\-_]/g, '--');
}

// ───────────────────────── Row coercion helpers ─────────────────────────
// sql.js returns `unknown` for every column; these narrow safely. Shared
// across sources / subscriptions / telemetry so the modules don't each
// re-roll their own.

export function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

export function asInt(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : fallback;
}

export function asIntOrNull(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

export function asStrOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
