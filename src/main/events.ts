import { getDb, isDbOpen, scheduleSave } from './db';
import type { EventKind, EventRow } from '../shared/events';

/**
 * A1 (dual-write Lite): every state-changing persistence operation
 * appends a row here. The existing per-feature tables (`agents`,
 * `log_lines`, `director_messages`, `log_notes`, etc.) stay primary
 * — `events` is an additive audit trail. Reads of state still go
 * through projection tables; consumers that want a stream
 * (F11 run-bundle export, F5 rewind) read this table.
 *
 * Body is opaque JSON at storage time so additive fields don't need
 * migrations. The shared `EventKind` enum is the only thing the
 * renderer needs; everything else is a string field whose meaning
 * is documented per-call-site.
 *
 * Best-effort writer: a failure here logs to stderr but never
 * throws, so a corrupt audit row never blocks the actual user-
 * visible write (which has already happened by the time we call
 * appendEvent).
 */

export function appendEvent(
  kind: EventKind,
  body: unknown,
  opts: { projectId?: string | null; agentId?: string | null } = {},
): void {
  if (!isDbOpen()) return;
  try {
    const db = getDb();
    const stmt = db.prepare(
      `INSERT INTO events (project_id, agent_id, ts, kind, body, schema_v)
       VALUES (?, ?, ?, ?, ?, 1)`,
    );
    stmt.run([
      opts.projectId ?? null,
      opts.agentId ?? null,
      Date.now(),
      kind,
      body === undefined ? null : JSON.stringify(body),
    ]);
    stmt.free();
    scheduleSave();
  } catch (e) {
    // Audit log is best-effort. The user's actual write already
    // succeeded (we're called after the INSERT/UPDATE), so a lost
    // audit row is recoverable from the projection tables.
    process.stderr.write(
      `[events] append failed (${kind}): ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

/**
 * Read a slice of the event log. All filters are optional and
 * combine with AND semantics. Pass `limit` to cap result size;
 * default is 1000, hard cap 50_000.
 */
export function listEvents(
  filter: {
    projectId?: string;
    agentId?: string;
    /** Strictly greater than (for incremental polling). */
    sinceSeq?: number;
    kinds?: ReadonlyArray<string>;
    limit?: number;
  } = {},
): EventRow[] {
  if (!isDbOpen()) return [];
  const db = getDb();
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.projectId) {
    where.push('project_id = ?');
    params.push(filter.projectId);
  }
  if (filter.agentId) {
    where.push('agent_id = ?');
    params.push(filter.agentId);
  }
  if (typeof filter.sinceSeq === 'number') {
    where.push('seq > ?');
    params.push(filter.sinceSeq);
  }
  if (filter.kinds && filter.kinds.length > 0) {
    const placeholders = filter.kinds.map(() => '?').join(', ');
    where.push(`kind IN (${placeholders})`);
    for (const k of filter.kinds) params.push(k);
  }
  const limit = Math.max(1, Math.min(filter.limit ?? 1000, 50_000));
  const sql =
    `SELECT seq, project_id, agent_id, ts, kind, body, schema_v
       FROM events` +
    (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY seq ASC LIMIT ${limit}`;
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const out: EventRow[] = [];
  while (stmt.step()) {
    const row = stmt.get();
    let body: unknown = null;
    const raw = row[5];
    if (typeof raw === 'string' && raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    out.push({
      seq: typeof row[0] === 'number' ? row[0] : 0,
      projectId: typeof row[1] === 'string' ? row[1] : null,
      agentId: typeof row[2] === 'string' ? row[2] : null,
      ts: typeof row[3] === 'number' ? row[3] : 0,
      kind: typeof row[4] === 'string' ? row[4] : '',
      body,
      schemaV: typeof row[6] === 'number' ? row[6] : 1,
    });
  }
  stmt.free();
  return out;
}

/**
 * Cheap row count without reading bodies. Used by diagnostics
 * panels that want "N events captured" without paying I/O.
 */
export function countEvents(
  filter: {
    projectId?: string;
    agentId?: string;
  } = {},
): number {
  if (!isDbOpen()) return 0;
  const db = getDb();
  const where: string[] = [];
  const params: string[] = [];
  if (filter.projectId) {
    where.push('project_id = ?');
    params.push(filter.projectId);
  }
  if (filter.agentId) {
    where.push('agent_id = ?');
    params.push(filter.agentId);
  }
  const sql =
    `SELECT COUNT(*) FROM events` +
    (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '');
  const res = db.exec(sql, params);
  if (res.length === 0) return 0;
  const v = res[0].values[0]?.[0];
  return typeof v === 'number' ? v : 0;
}
