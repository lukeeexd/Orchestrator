import type {
  Agent,
  DirectorMessage,
  LogLine,
  ToolCall,
} from '../shared/types';
import { DEFAULT_EFFORT, isEffortLevel } from '../shared/efforts';
import { getDb, scheduleSave } from './db';
import { appendEvent } from './events';
import { EventKinds } from '../shared/events';

let messageOrdering = 0;
let agentOrdering = 0;
const logSeq = new Map<string, number>();

function asInt(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : fallback;
}

function parseModelUsage(
  raw: unknown,
): Record<string, { tokens: number; cost: number }> | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const out: Record<string, { tokens: number; cost: number }> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v && typeof v === 'object') {
        const entry = v as { tokens?: number; cost?: number };
        out[k] = {
          tokens: typeof entry.tokens === 'number' ? entry.tokens : 0,
          cost: typeof entry.cost === 'number' ? entry.cost : 0,
        };
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

// ─────────────────────────── Director ───────────────────────────

export function saveDirectorMessage(m: DirectorMessage): void {
  const db = getDb();
  messageOrdering += 1;
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO director_messages
      (id, ordering, who, name, time, body, plan, plan_accepted, live, attachments, redirect, redirect_fired, project_id, prd, critique, questions, confidence, ledger)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run([
    m.id,
    messageOrdering,
    m.who,
    m.name,
    m.time,
    m.body,
    m.plan ? JSON.stringify(m.plan) : null,
    m.planAccepted ? 1 : 0,
    m.live ? 1 : 0,
    m.attachments && m.attachments.length > 0
      ? JSON.stringify(m.attachments)
      : null,
    m.redirect ? JSON.stringify(m.redirect) : null,
    m.redirectFired ? 1 : 0,
    m.projectId,
    m.prd ? JSON.stringify(m.prd) : null,
    m.critique ? JSON.stringify(m.critique) : null,
    m.questions ? JSON.stringify(m.questions) : null,
    m.confidence ? JSON.stringify(m.confidence) : null,
    m.ledger ? JSON.stringify(m.ledger) : null,
  ]);
  stmt.free();
  // A1: audit append. We log the creation moment; subsequent
  // patches (live → settled, plan_accepted, etc.) don't generate
  // events. Final state lives in the projection table; F11 / F5
  // join events.kind='director.message' onto director_messages.id
  // for the latest body.
  appendEvent(
    EventKinds.DirectorMessage,
    {
      id: m.id,
      who: m.who,
      name: m.name,
      live: m.live ?? false,
      body: m.body,
      plan: m.plan,
      redirect: m.redirect,
      prd: m.prd,
      critique: m.critique,
      questions: m.questions,
      confidence: m.confidence,
      attachments: m.attachments,
    },
    { projectId: m.projectId },
  );
  scheduleSave();
}

export function patchDirectorMessage(
  id: string,
  patch: Partial<DirectorMessage>,
): void {
  const db = getDb();
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if ('body' in patch && patch.body !== undefined) {
    sets.push('body = ?');
    values.push(patch.body);
  }
  if ('plan' in patch) {
    sets.push('plan = ?');
    values.push(patch.plan ? JSON.stringify(patch.plan) : null);
  }
  if ('planAccepted' in patch) {
    sets.push('plan_accepted = ?');
    values.push(patch.planAccepted ? 1 : 0);
  }
  if ('live' in patch) {
    sets.push('live = ?');
    values.push(patch.live ? 1 : 0);
  }
  if ('redirect' in patch) {
    sets.push('redirect = ?');
    values.push(patch.redirect ? JSON.stringify(patch.redirect) : null);
  }
  if ('redirectFired' in patch) {
    sets.push('redirect_fired = ?');
    values.push(patch.redirectFired ? 1 : 0);
  }
  if ('prd' in patch) {
    sets.push('prd = ?');
    values.push(patch.prd ? JSON.stringify(patch.prd) : null);
  }
  if ('critique' in patch) {
    sets.push('critique = ?');
    values.push(patch.critique ? JSON.stringify(patch.critique) : null);
  }
  if ('questions' in patch) {
    sets.push('questions = ?');
    values.push(patch.questions ? JSON.stringify(patch.questions) : null);
  }
  if ('confidence' in patch) {
    sets.push('confidence = ?');
    values.push(patch.confidence ? JSON.stringify(patch.confidence) : null);
  }
  if ('ledger' in patch) {
    sets.push('ledger = ?');
    values.push(patch.ledger ? JSON.stringify(patch.ledger) : null);
  }
  if (sets.length === 0) return;
  values.push(id);
  const stmt = db.prepare(
    `UPDATE director_messages SET ${sets.join(', ')} WHERE id = ?`,
  );
  stmt.run(values);
  stmt.free();
  scheduleSave();
}

export function loadDirectorMessages(projectId: string): DirectorMessage[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT id, ordering, who, name, time, body, plan, plan_accepted, live, attachments, redirect, redirect_fired, project_id, prd, critique, questions, confidence, ledger
    FROM director_messages
    WHERE project_id = ?
    ORDER BY ordering ASC
  `);
  stmt.bind([projectId]);
  const rows: unknown[][] = [];
  while (stmt.step()) rows.push(stmt.get());
  stmt.free();
  if (rows.length === 0) return [];
  const out: DirectorMessage[] = [];
  for (const row of rows) {
    const planRaw = row[6];
    let plan: DirectorMessage['plan'];
    if (typeof planRaw === 'string' && planRaw.length > 0) {
      try {
        plan = JSON.parse(planRaw);
      } catch {
        plan = undefined;
      }
    }
    const attRaw = row[9];
    let attachments: DirectorMessage['attachments'];
    if (typeof attRaw === 'string' && attRaw.length > 0) {
      try {
        attachments = JSON.parse(attRaw);
      } catch {
        attachments = undefined;
      }
    }
    const redirectRaw = row[10];
    let redirect: DirectorMessage['redirect'];
    if (typeof redirectRaw === 'string' && redirectRaw.length > 0) {
      try {
        redirect = JSON.parse(redirectRaw);
      } catch {
        redirect = undefined;
      }
    }
    const prdRaw = row[13];
    let prd: DirectorMessage['prd'];
    if (typeof prdRaw === 'string' && prdRaw.length > 0) {
      try {
        prd = JSON.parse(prdRaw);
      } catch {
        prd = undefined;
      }
    }
    const critRaw = row[14];
    let critique: DirectorMessage['critique'];
    if (typeof critRaw === 'string' && critRaw.length > 0) {
      try {
        critique = JSON.parse(critRaw);
      } catch {
        critique = undefined;
      }
    }
    const questionsRaw = row[15];
    let questions: DirectorMessage['questions'];
    if (typeof questionsRaw === 'string' && questionsRaw.length > 0) {
      try {
        questions = JSON.parse(questionsRaw);
      } catch {
        questions = undefined;
      }
    }
    const confidenceRaw = row[16];
    let confidence: DirectorMessage['confidence'];
    if (typeof confidenceRaw === 'string' && confidenceRaw.length > 0) {
      try {
        confidence = JSON.parse(confidenceRaw);
      } catch {
        confidence = undefined;
      }
    }
    const ledgerRaw = row[17];
    let ledger: DirectorMessage['ledger'];
    if (typeof ledgerRaw === 'string' && ledgerRaw.length > 0) {
      try {
        ledger = JSON.parse(ledgerRaw);
      } catch {
        ledger = undefined;
      }
    }
    out.push({
      id: asStr(row[0]),
      projectId: asStr(row[12], projectId),
      who: asStr(row[2]) as DirectorMessage['who'],
      name: asStr(row[3]),
      time: asStr(row[4]),
      body: asStr(row[5]),
      plan,
      planAccepted: asInt(row[7]) === 1,
      live: false, // never restore live state — runs reset on app start
      attachments,
      redirect,
      redirectFired: asInt(row[11]) === 1,
      prd,
      critique,
      questions,
      confidence,
      ledger,
    });
    messageOrdering = Math.max(messageOrdering, asInt(row[1]));
  }
  return out;
}

// ────────────────────── Director session id ─────────────────────

const sessionKey = (projectId: string) =>
  `project:${projectId}:director_session_id`;

/**
 * F5: truncate a project's Director chat to everything UP TO AND
 * INCLUDING the given message. The user picks a known-good point
 * (via "Rewind here" in the renderer); we drop everything after
 * it so the next turn re-runs from that anchor. The chosen
 * message itself is preserved so the user can see the context
 * that led them to rewind.
 *
 * Caller (`director.rewindTo`) is responsible for clearing the
 * saved Director session id separately (via
 * `clearDirectorSessionId`) so the next turn spawns a fresh CLI
 * session instead of trying to `--resume` a session whose
 * conversation memory references the truncated turns. This
 * sidesteps the resume-after-truncation semantics question
 * entirely — F5 doesn't actually need that to work.
 */
export function rewindDirectorMessagesTo(
  projectId: string,
  messageId: string,
): { ok: boolean; truncatedCount: number; error?: string } {
  const db = getDb();
  const probe = db.exec(
    `SELECT ordering FROM director_messages
      WHERE project_id = ? AND id = ?`,
    [projectId, messageId],
  );
  if (probe.length === 0 || probe[0].values.length === 0) {
    return { ok: false, truncatedCount: 0, error: 'message not found' };
  }
  const anchorOrdering =
    typeof probe[0].values[0][0] === 'number' ? probe[0].values[0][0] : 0;

  const countRes = db.exec(
    `SELECT COUNT(*) FROM director_messages
      WHERE project_id = ? AND ordering > ?`,
    [projectId, anchorOrdering],
  );
  const truncatedCount =
    countRes.length > 0 && typeof countRes[0].values[0][0] === 'number'
      ? countRes[0].values[0][0]
      : 0;

  appendEvent(
    EventKinds.DirectorRewind,
    { toMessageId: messageId, truncatedCount },
    { projectId },
  );

  const stmt = db.prepare(
    `DELETE FROM director_messages
       WHERE project_id = ? AND ordering > ?`,
  );
  stmt.run([projectId, anchorOrdering]);
  stmt.free();
  scheduleSave();
  return { ok: true, truncatedCount };
}

/**
 * Drop every persisted Director artifact for one project: chat messages
 * + the saved SDK session id. Leaves the project itself and its agents
 * intact — this is the "clear chat" operation, not project deletion.
 */
export function wipeDirector(projectId: string): void {
  // A1: audit append BEFORE the delete so the event records the
  // intent at the moment it happened. The empty body is sufficient
  // — `project_id` on the row scopes the event.
  appendEvent(EventKinds.DirectorWipe, {}, { projectId });
  const db = getDb();
  const dm = db.prepare(`DELETE FROM director_messages WHERE project_id = ?`);
  dm.run([projectId]);
  dm.free();
  const kv = db.prepare(`DELETE FROM kv WHERE key = ?`);
  kv.run([sessionKey(projectId)]);
  kv.free();
  scheduleSave();
}

export function saveDirectorSessionId(
  projectId: string,
  sessionId: string,
): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`,
  );
  stmt.run([sessionKey(projectId), sessionId]);
  stmt.free();
  scheduleSave();
}

/**
 * Drop just the saved Director session id, leaving chat messages
 * intact. Used when the Director's provider changes — the new CLI
 * can't resume a session created by the old one, so the next turn
 * has to start fresh.
 */
export function clearDirectorSessionId(projectId: string): void {
  const db = getDb();
  const stmt = db.prepare(`DELETE FROM kv WHERE key = ?`);
  stmt.run([sessionKey(projectId)]);
  stmt.free();
  scheduleSave();
}

export function loadDirectorSessionId(projectId: string): string | null {
  const db = getDb();
  const stmt = db.prepare(`SELECT value FROM kv WHERE key = ?`);
  stmt.bind([sessionKey(projectId)]);
  let value: string | null = null;
  if (stmt.step()) {
    const v = stmt.getAsObject().value;
    if (typeof v === 'string') value = v;
  }
  stmt.free();
  return value;
}

// ──────────────────────────── Agents ────────────────────────────

export function saveAgent(a: Agent): void {
  const db = getDb();
  agentOrdering += 1;
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO agents
      (id, ordering, role, role_label, name, status, status_label, step, task,
       tokens, cost, elapsed, model, workspace,
       budget_usd, budget_tokens, budget_seconds,
       spawned_by, started_at, session_id, project_id, effort,
       forked_from_id, forked_from_name, model_usage, provider, subtype, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run([
    a.id,
    agentOrdering,
    a.role,
    a.roleLabel,
    a.name,
    a.status,
    a.statusLabel,
    a.step,
    a.task,
    a.tokens,
    a.cost,
    a.elapsed,
    a.model,
    a.workspace,
    a.budget.usd,
    a.budget.tokens,
    a.budget.seconds,
    a.spawnedBy,
    a.startedAt,
    a.sessionId ?? null,
    a.projectId,
    a.effort,
    a.forkedFromId ?? null,
    a.forkedFromName ?? null,
    a.modelUsage ? JSON.stringify(a.modelUsage) : null,
    a.provider ?? null,
    a.subtype ?? null,
    a.endedAt ?? null,
  ]);
  stmt.free();
  // A1: audit append. agent.spawn carries the immutable creation
  // metadata — role, name, task, model, etc. Subsequent mutations
  // flow through `patchAgent` and emit `agent.patch` events.
  // Forks set `forkedFromId`; this lets F11 / F5 reconstruct the
  // spawn tree without joining anything.
  appendEvent(
    EventKinds.AgentSpawn,
    {
      id: a.id,
      role: a.role,
      subtype: a.subtype,
      name: a.name,
      task: a.task,
      model: a.model,
      effort: a.effort,
      provider: a.provider,
      workspace: a.workspace,
      budget: a.budget,
      spawnedBy: a.spawnedBy,
      forkedFromId: a.forkedFromId,
      forkedFromName: a.forkedFromName,
      startedAt: a.startedAt,
    },
    { projectId: a.projectId, agentId: a.id },
  );
  scheduleSave();
}

export function patchAgent(id: string, patch: Partial<Agent>): void {
  const db = getDb();
  const sets: string[] = [];
  const values: (string | number)[] = [];
  if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
  if (patch.statusLabel !== undefined) { sets.push('status_label = ?'); values.push(patch.statusLabel); }
  if (patch.step !== undefined) { sets.push('step = ?'); values.push(patch.step); }
  if (patch.tokens !== undefined) { sets.push('tokens = ?'); values.push(patch.tokens); }
  if (patch.cost !== undefined) { sets.push('cost = ?'); values.push(patch.cost); }
  if (patch.elapsed !== undefined) { sets.push('elapsed = ?'); values.push(patch.elapsed); }
  if (patch.sessionId !== undefined) { sets.push('session_id = ?'); values.push(patch.sessionId); }
  if (patch.model !== undefined) { sets.push('model = ?'); values.push(patch.model); }
  if (patch.effort !== undefined) { sets.push('effort = ?'); values.push(patch.effort); }
  if (patch.modelUsage !== undefined) {
    sets.push('model_usage = ?');
    values.push(JSON.stringify(patch.modelUsage));
  }
  if (patch.endedAt !== undefined) {
    sets.push('ended_at = ?');
    // null clears the column (e.g. redirect flips back to running);
    // a number stamps the terminal moment.
    values.push(patch.endedAt === null ? (null as unknown as number) : patch.endedAt);
  }
  if (sets.length === 0) return;
  values.push(id);
  const stmt = db.prepare(
    `UPDATE agents SET ${sets.join(', ')} WHERE id = ?`,
  );
  stmt.run(values);
  stmt.free();
  // A1: audit append. We log the patch as-supplied so F5's rewind
  // can reconstruct any past field. modelUsage gets pruned from the
  // body — it grows unboundedly across long sessions and would
  // bloat the audit table; rewind consumers can read the projection
  // table's final value.
  const { modelUsage, ...auditable } = patch;
  void modelUsage;
  if (Object.keys(auditable).length > 0) {
    appendEvent(EventKinds.AgentPatch, auditable, { agentId: id });
  }
  scheduleSave();
}

export function appendLogLine(agentId: string, line: LogLine): void {
  const db = getDb();
  const next = (logSeq.get(agentId) ?? 0) + 1;
  logSeq.set(agentId, next);
  const stmt = db.prepare(`
    INSERT INTO log_lines (agent_id, seq, ts, kind, msg)
    VALUES (?, ?, ?, ?, ?)
  `);
  const msg = typeof line.msg === 'string' ? line.msg : JSON.stringify(line.msg);
  stmt.run([agentId, next, line.ts, line.kind, msg]);
  stmt.free();
  // A1: audit append — one event per log line, body mirrors the
  // LogLine shape so F11's export is a 1:1 replay.
  appendEvent(
    EventKinds.AgentLog,
    { ts: line.ts, kind: line.kind, msg: line.msg },
    { agentId },
  );
  scheduleSave();
}

export function loadAgents(): Agent[] {
  const db = getDb();
  const res = db.exec(`
    SELECT id, ordering, role, role_label, name, status, status_label, step, task,
           tokens, cost, elapsed, model, workspace,
           budget_usd, budget_tokens, budget_seconds, spawned_by, started_at, session_id, project_id, effort,
           forked_from_id, forked_from_name, model_usage, provider, subtype, ended_at
    FROM agents ORDER BY ordering ASC
  `);
  if (res.length === 0) return [];
  const out: Agent[] = [];
  for (const row of res[0].values) {
    const sid = row[19];
    const effortRaw = row[21];
    const forkedId = row[22];
    const forkedName = row[23];
    const modelUsageRaw = row[24];
    const providerRaw = row[25];
    const subtypeRaw = row[26];
    const endedAtRaw = row[27];
    out.push({
      id: asStr(row[0]),
      projectId: asStr(row[20]),
      role: asStr(row[2]) as Agent['role'],
      roleLabel: asStr(row[3]),
      name: asStr(row[4]),
      status: asStr(row[5]) as Agent['status'],
      statusLabel: asStr(row[6]),
      step: asStr(row[7]),
      task: asStr(row[8]),
      tokens: asInt(row[9]),
      cost: typeof row[10] === 'number' ? row[10] : 0,
      elapsed: asStr(row[11]),
      model: asStr(row[12]),
      workspace: asStr(row[13]),
      budget: {
        usd: typeof row[14] === 'number' ? row[14] : 0,
        tokens: asInt(row[15]),
        seconds: asInt(row[16]),
      },
      spawnedBy: asStr(row[17]) as Agent['spawnedBy'],
      log: [],
      startedAt: asInt(row[18]),
      sessionId: typeof sid === 'string' && sid.length > 0 ? sid : undefined,
      // Agents stored before schema v8 don't have an effort column; fall
      // back to DEFAULT_EFFORT rather than carrying NULL through to the SDK.
      effort: isEffortLevel(effortRaw) ? effortRaw : DEFAULT_EFFORT,
      forkedFromId:
        typeof forkedId === 'string' && forkedId.length > 0
          ? forkedId
          : undefined,
      forkedFromName:
        typeof forkedName === 'string' && forkedName.length > 0
          ? forkedName
          : undefined,
      modelUsage: parseModelUsage(modelUsageRaw),
      provider:
        providerRaw === 'claude' || providerRaw === 'codex'
          ? providerRaw
          : undefined,
      subtype: subtypeRaw === 'playwright' ? 'playwright' : undefined,
      endedAt: typeof endedAtRaw === 'number' ? endedAtRaw : undefined,
    });
    agentOrdering = Math.max(agentOrdering, asInt(row[1]));
  }
  // Load log lines per agent.
  //
  // H5: only the trailing LOG_TAIL_HYDRATE_CAP lines per agent get
  // hydrated into memory. The full history stays in the DB and can
  // be fetched on demand via listLogLinesForAgent (e.g. when the
  // Drawer opens). Before this fix, startup loaded every log line
  // for every agent into memory — a long-lived install with N
  // chatty agents was holding tens of MiB unnecessarily.
  //
  // We also seed logSeq from the max(seq) across the table, not
  // from the loaded subset — otherwise an agent whose tail-only
  // hydrate skipped earlier seqs would re-use a seq and conflict
  // with the disk record on next appendLogLine.
  for (const agent of out) {
    const maxSeqRes = db.exec(
      `SELECT COALESCE(MAX(seq), 0) FROM log_lines WHERE agent_id = ?`,
      [agent.id],
    );
    if (maxSeqRes.length > 0 && maxSeqRes[0].values.length > 0) {
      const v = maxSeqRes[0].values[0][0];
      if (typeof v === 'number') logSeq.set(agent.id, v);
    }
    const lr = db.exec(
      `SELECT seq, ts, kind, msg FROM log_lines
       WHERE agent_id = ? ORDER BY seq DESC LIMIT ?`,
      [agent.id, LOG_TAIL_HYDRATE_CAP],
    );
    if (lr.length > 0) {
      // Reverse so we end up in ascending seq order in agent.log.
      const tail: LogLine[] = [];
      for (const lrow of lr[0].values) {
        const kind = asStr(lrow[2]) as LogLine['kind'];
        tail.push({
          ts: asStr(lrow[1]),
          kind,
          msg: parseStoredMsg(kind, asStr(lrow[3])),
        });
      }
      tail.reverse();
      agent.log = tail;
    }
  }
  return out;
}

/**
 * M13: parse a stored log-line msg back into its in-memory shape.
 * Replaces the previous "starts with `{`" probe with a discriminator
 * on the LogLine kind — tool entries are the only ones that
 * serialize a ToolCall; every other kind is a plain string. A bare
 * `{` at the start of a thought line no longer trips a spurious
 * JSON.parse.
 */
function parseStoredMsg(
  kind: LogLine['kind'],
  raw: string,
): string | ToolCall {
  if (kind !== 'tool') return raw;
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === 'object' && 'fn' in obj) {
      return obj as ToolCall;
    }
  } catch {
    // Persisted tool line that didn't deserialize — surface the raw
    // text rather than dropping the entry. The renderer's LogLineRow
    // handles either branch of the union.
  }
  return raw;
}

/**
 * Trailing-window cap on startup hydration. Matches the runner's
 * live LOG_TAIL_CAP so the in-memory shape is consistent whether
 * the agent ran this session or was rehydrated from disk.
 */
const LOG_TAIL_HYDRATE_CAP = 2000;

/**
 * Fetch a slice of an agent's log lines from disk. Used by the
 * Drawer when the user wants to scroll past the in-memory tail.
 *
 * Returns lines in ascending seq order, up to `limit` entries
 * ending at the given inclusive `beforeSeq` (or the latest seq if
 * undefined). Caller can paginate by passing the lowest seq from
 * the prior page as the next `beforeSeq`.
 */
export function listLogLinesForAgent(
  agentId: string,
  limit: number,
  beforeSeq?: number,
): LogLine[] {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(limit, 5000));
  const rows = beforeSeq
    ? db.exec(
        `SELECT seq, ts, kind, msg FROM log_lines
         WHERE agent_id = ? AND seq < ?
         ORDER BY seq DESC LIMIT ?`,
        [agentId, beforeSeq, safeLimit],
      )
    : db.exec(
        `SELECT seq, ts, kind, msg FROM log_lines
         WHERE agent_id = ?
         ORDER BY seq DESC LIMIT ?`,
        [agentId, safeLimit],
      );
  if (rows.length === 0) return [];
  const out: LogLine[] = [];
  for (const lrow of rows[0].values) {
    const kind = asStr(lrow[2]) as LogLine['kind'];
    out.push({
      ts: asStr(lrow[1]),
      kind,
      msg: parseStoredMsg(kind, asStr(lrow[3])),
    });
  }
  out.reverse();
  return out;
}

export function deleteAgent(id: string): void {
  // A1: audit append BEFORE the projection-table delete so the
  // event sees the agent still existed at write time. Body is
  // empty — the agent.spawn event captures everything F11 / F5
  // need to know about who was removed.
  appendEvent(EventKinds.AgentDelete, {}, { agentId: id });
  const db = getDb();
  const a = db.prepare(`DELETE FROM agents WHERE id = ?`);
  a.run([id]);
  a.free();
  const l = db.prepare(`DELETE FROM log_lines WHERE agent_id = ?`);
  l.run([id]);
  l.free();
  scheduleSave();
}

/**
 * Mark any agents that were in flight when the app closed as failed —
 * we can't resume their SDK sessions.
 */
export function markRunningAgentsAsInterrupted(): void {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE agents SET status = 'error', status_label = 'Interrupted'
    WHERE status IN ('running', 'waiting')
  `);
  stmt.run();
  stmt.free();
  scheduleSave();
}
