import { getDb, isDbOpen, scheduleSave } from './db';

/**
 * F6: per-project secrets vault. Runtime API for storing + injecting
 * env vars into agent spawns without ever putting them in prompts.
 *
 * Storage shape: `project_secrets(project_id, name, value, updated_at)`,
 * composite PK on (project_id, name). Names are env-var shaped — see
 * NAME_PATTERN below. Values are arbitrary strings.
 *
 * Trust model: the renderer can list names + set / delete entries, and
 * can fetch a single value back via `readSecretValue` for inline edit
 * (rare; only when the user clicks "reveal"). The bulk
 * `getSecretsForSpawn` is main-only and is the runner's hook to push
 * the env into the spawned child process.
 */

export const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,62}$/;
const MAX_VALUE_BYTES = 64 * 1024; // 64 KB

export interface SecretListEntry {
  name: string;
  /** ISO ms timestamp of the last write. */
  updatedAt: number;
  /** Length of the stored value in characters — useful for the UI to render `••• (12)`. */
  valueLength: number;
}

export function assertValidName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      'Secret name must be uppercase letters / digits / underscores ' +
        '(start with a letter), max 63 chars — env-var shape.',
    );
  }
}

/**
 * List every secret for a project. Returns metadata only — the
 * value never crosses the IPC boundary in bulk so a casual log of
 * the IPC response can't leak the whole vault.
 */
export function listSecrets(projectId: string): SecretListEntry[] {
  if (!isDbOpen()) return [];
  const db = getDb();
  const stmt = db.prepare(
    `SELECT name, updated_at, length(value) AS len
       FROM project_secrets
      WHERE project_id = ?
      ORDER BY name ASC`,
  );
  stmt.bind([projectId]);
  const out: SecretListEntry[] = [];
  while (stmt.step()) {
    const row = stmt.get();
    out.push({
      name: typeof row[0] === 'string' ? row[0] : '',
      updatedAt: typeof row[1] === 'number' ? row[1] : 0,
      valueLength: typeof row[2] === 'number' ? row[2] : 0,
    });
  }
  stmt.free();
  return out;
}

/**
 * Fetch a single secret's value. Used by the renderer when the user
 * explicitly clicks "reveal" on a row to edit the existing value.
 * Returns null when not found.
 */
export function readSecretValue(
  projectId: string,
  name: string,
): string | null {
  if (!isDbOpen()) return null;
  const db = getDb();
  const stmt = db.prepare(
    `SELECT value FROM project_secrets WHERE project_id = ? AND name = ?`,
  );
  stmt.bind([projectId, name]);
  let out: string | null = null;
  if (stmt.step()) {
    const row = stmt.get();
    if (typeof row[0] === 'string') out = row[0];
  }
  stmt.free();
  return out;
}

/**
 * Insert-or-replace a secret. Validates name shape and value size.
 * Throws on invalid input so the IPC handler can surface the error
 * to the renderer.
 */
export function setSecret(
  projectId: string,
  name: string,
  value: string,
): void {
  if (!isDbOpen()) throw new Error('database not open');
  assertValidName(name);
  if (value.length > MAX_VALUE_BYTES) {
    throw new Error(
      `Secret value too large (${value.length} chars; max ${MAX_VALUE_BYTES}).`,
    );
  }
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO project_secrets (project_id, name, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id, name)
     DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  stmt.run([projectId, name, value, Date.now()]);
  stmt.free();
  scheduleSave();
}

/** Delete a single secret. Idempotent — no-op when the row doesn't exist. */
export function deleteSecret(projectId: string, name: string): void {
  if (!isDbOpen()) return;
  const db = getDb();
  const stmt = db.prepare(
    `DELETE FROM project_secrets WHERE project_id = ? AND name = ?`,
  );
  stmt.run([projectId, name]);
  stmt.free();
  scheduleSave();
}

/**
 * Bulk-read every secret for a project, shaped for env-injection into
 * a spawned child process. Main-only — the runner imports this
 * directly; never crosses IPC. Returns an empty object when the
 * project has no secrets (or the DB is closed during shutdown).
 */
export function getSecretsForSpawn(projectId: string): Record<string, string> {
  if (!isDbOpen()) return {};
  const db = getDb();
  const stmt = db.prepare(
    `SELECT name, value FROM project_secrets WHERE project_id = ?`,
  );
  stmt.bind([projectId]);
  const out: Record<string, string> = {};
  while (stmt.step()) {
    const row = stmt.get();
    const name = typeof row[0] === 'string' ? row[0] : '';
    const value = typeof row[1] === 'string' ? row[1] : '';
    if (name) out[name] = value;
  }
  stmt.free();
  return out;
}

/**
 * Validate a secret value against the same byte cap setSecret enforces.
 * Exposed so the IPC layer can reject early without touching the DB.
 */
export function assertValidValue(value: string): void {
  if (value.length > MAX_VALUE_BYTES) {
    throw new Error(
      `Secret value too large (${value.length} chars; max ${MAX_VALUE_BYTES}).`,
    );
  }
}
