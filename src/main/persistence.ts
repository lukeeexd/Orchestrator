import type {
  Agent,
  DirectorMessage,
  LogLine,
  ToolCall,
} from '../shared/types';
import { DEFAULT_EFFORT, isEffortLevel } from '../shared/efforts';
import { getDb, scheduleSave } from './db';

let messageOrdering = 0;
let agentOrdering = 0;
const logSeq = new Map<string, number>();

function asInt(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : fallback;
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
      (id, ordering, who, name, time, body, plan, plan_accepted, live, attachments, redirect, redirect_fired, project_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  ]);
  stmt.free();
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
    SELECT id, ordering, who, name, time, body, plan, plan_accepted, live, attachments, redirect, redirect_fired, project_id
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
    });
    messageOrdering = Math.max(messageOrdering, asInt(row[1]));
  }
  return out;
}

// ────────────────────── Director session id ─────────────────────

const sessionKey = (projectId: string) =>
  `project:${projectId}:director_session_id`;

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
       forked_from_id, forked_from_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  ]);
  stmt.free();
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
  if (sets.length === 0) return;
  values.push(id);
  const stmt = db.prepare(
    `UPDATE agents SET ${sets.join(', ')} WHERE id = ?`,
  );
  stmt.run(values);
  stmt.free();
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
  scheduleSave();
}

export function loadAgents(): Agent[] {
  const db = getDb();
  const res = db.exec(`
    SELECT id, ordering, role, role_label, name, status, status_label, step, task,
           tokens, cost, elapsed, model, workspace,
           budget_usd, budget_tokens, budget_seconds, spawned_by, started_at, session_id, project_id, effort,
           forked_from_id, forked_from_name
    FROM agents ORDER BY ordering ASC
  `);
  if (res.length === 0) return [];
  const out: Agent[] = [];
  for (const row of res[0].values) {
    const sid = row[19];
    const effortRaw = row[21];
    const forkedId = row[22];
    const forkedName = row[23];
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
    });
    agentOrdering = Math.max(agentOrdering, asInt(row[1]));
  }
  // Load log lines per agent
  for (const agent of out) {
    const lr = db.exec(
      `SELECT seq, ts, kind, msg FROM log_lines WHERE agent_id = ? ORDER BY seq ASC`,
      [agent.id],
    );
    if (lr.length > 0) {
      for (const lrow of lr[0].values) {
        const seq = asInt(lrow[0]);
        const rawMsg = asStr(lrow[3]);
        let parsedMsg: string | ToolCall = rawMsg;
        if (rawMsg.startsWith('{')) {
          try {
            const obj = JSON.parse(rawMsg);
            if (obj && typeof obj === 'object' && 'fn' in obj) {
              parsedMsg = obj as ToolCall;
            }
          } catch {
            // leave as string
          }
        }
        agent.log.push({
          ts: asStr(lrow[1]),
          kind: asStr(lrow[2]) as LogLine['kind'],
          msg: parsedMsg,
        });
        logSeq.set(agent.id, Math.max(logSeq.get(agent.id) ?? 0, seq));
      }
    }
  }
  return out;
}

export function deleteAgent(id: string): void {
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
