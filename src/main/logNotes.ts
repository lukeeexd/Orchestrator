import { getDb, isDbOpen, scheduleSave } from './db';

/**
 * F12: per-line notes pinned to an agent's log. Renderer-driven
 * line keys (FNV-1a hex of ts+kind+msg, see shared/logNotes.ts)
 * survive log re-hydration so notes don't drift if the in-memory
 * log is reloaded from disk.
 */

const MAX_BODY_BYTES = 8 * 1024; // 8 KB per note — plenty for a paragraph

export interface LogNote {
  lineKey: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Return every note for an agent. The renderer typically fetches
 * once on agent select and indexes by lineKey for O(1) lookup
 * during the log-line render pass.
 */
export function listNotes(agentId: string): LogNote[] {
  if (!isDbOpen()) return [];
  const db = getDb();
  const stmt = db.prepare(
    `SELECT line_key, body, created_at, updated_at
       FROM log_notes
      WHERE agent_id = ?
      ORDER BY updated_at DESC`,
  );
  stmt.bind([agentId]);
  const out: LogNote[] = [];
  while (stmt.step()) {
    const row = stmt.get();
    out.push({
      lineKey: typeof row[0] === 'string' ? row[0] : '',
      body: typeof row[1] === 'string' ? row[1] : '',
      createdAt: typeof row[2] === 'number' ? row[2] : 0,
      updatedAt: typeof row[3] === 'number' ? row[3] : 0,
    });
  }
  stmt.free();
  return out;
}

/**
 * Insert-or-replace a note. Empty body deletes the row — the
 * renderer's textarea-clear-and-save path is effectively a delete.
 */
export function setNote(
  agentId: string,
  lineKey: string,
  body: string,
): void {
  if (!isDbOpen()) throw new Error('database not open');
  if (!lineKey) throw new Error('lineKey required');
  if (body.length > MAX_BODY_BYTES) {
    throw new Error(
      `Note too large (${body.length} chars; max ${MAX_BODY_BYTES}).`,
    );
  }
  if (body.length === 0) {
    deleteNote(agentId, lineKey);
    return;
  }
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO log_notes (agent_id, line_key, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(agent_id, line_key)
     DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
  );
  stmt.run([agentId, lineKey, body, now, now]);
  stmt.free();
  scheduleSave();
}

/** Idempotent delete — no-op when the row doesn't exist. */
export function deleteNote(agentId: string, lineKey: string): void {
  if (!isDbOpen()) return;
  const db = getDb();
  const stmt = db.prepare(
    `DELETE FROM log_notes WHERE agent_id = ? AND line_key = ?`,
  );
  stmt.run([agentId, lineKey]);
  stmt.free();
  scheduleSave();
}

/**
 * Bulk-delete every note for an agent. Called from the agent-delete
 * path so we don't leave orphaned rows behind.
 */
export function deleteNotesForAgent(agentId: string): void {
  if (!isDbOpen()) return;
  const db = getDb();
  const stmt = db.prepare(`DELETE FROM log_notes WHERE agent_id = ?`);
  stmt.run([agentId]);
  stmt.free();
  scheduleSave();
}
