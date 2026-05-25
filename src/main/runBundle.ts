import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import AdmZip from 'adm-zip';
import { getDb, isDbOpen } from './db';
import { scrubSecrets } from './secretScrubber';
import type { EventRow } from '../shared/events';

/**
 * F11: portable run-bundle export. Slices the A1 events table (for
 * the requested agents) + their final-state projections + the
 * project's Director chat into a single `.orun` zip suitable for
 * sharing — PR descriptions, postmortems, external review.
 *
 * Now that A1 ships a real event log, the bundle is just an event
 * slice plus a few projection-table lookups; no more re-stitching
 * from heuristic handoff parsers (the A7 re-cost the architect
 * flagged).
 *
 * v1 is single-agent or multi-agent-from-the-same-project export.
 * Cross-project bundles aren't a use case yet — pick one project's
 * runs at a time. The IPC validates that constraint.
 */

interface BundleAgentRow {
  id: string;
  projectId: string;
  role: string;
  roleLabel: string;
  name: string;
  status: string;
  statusLabel: string;
  step: string;
  task: string;
  tokens: number;
  cost: number;
  elapsed: string;
  model: string;
  effort: string;
  workspace: string;
  startedAt: number;
  endedAt: number | null;
  spawnedBy: string;
  forkedFromId: string | null;
  forkedFromName: string | null;
  provider: string | null;
  subtype: string | null;
  modelUsage: unknown;
}

interface BundleDirectorMessage {
  id: string;
  who: string;
  name: string;
  time: string;
  body: string;
  plan: unknown;
  redirect: unknown;
  prd: unknown;
  planAccepted: number;
  redirectFired: number;
}

export interface ExportRunBundleResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export function exportRunBundle(
  agentIds: string[],
  opts: { scrubSecrets: boolean },
): ExportRunBundleResult {
  if (!isDbOpen()) {
    return { ok: false, error: 'database not open' };
  }
  if (!Array.isArray(agentIds) || agentIds.length === 0) {
    return { ok: false, error: 'agentIds must be a non-empty array' };
  }
  if (agentIds.length > 50) {
    return {
      ok: false,
      error: `Too many agents in one bundle (${agentIds.length}; max 50).`,
    };
  }

  // Read each agent's projection row. Bail if any requested id is
  // missing — partial bundles would silently lose context.
  let agents: BundleAgentRow[];
  try {
    agents = readAgentsByIds(agentIds);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'agent read failed',
    };
  }
  if (agents.length !== agentIds.length) {
    const found = new Set(agents.map((a) => a.id));
    const missing = agentIds.filter((id) => !found.has(id));
    return {
      ok: false,
      error: `Agent(s) not found: ${missing.join(', ')}`,
    };
  }

  // Single-project guard. The first agent's projectId is the bundle's
  // scope; reject if any other agent belongs to a different project.
  const projectId = agents[0].projectId;
  const wrongProject = agents.find((a) => a.projectId !== projectId);
  if (wrongProject) {
    return {
      ok: false,
      error:
        `All agents must belong to the same project. ` +
        `${wrongProject.id} is in '${wrongProject.projectId}', ` +
        `expected '${projectId}'.`,
    };
  }

  const scrub = opts.scrubSecrets ? scrubSecrets : (s: string) => s;

  // Event slice: all events for the requested agents UNION the
  // project's Director events (correlates spawn with the plan-row
  // that produced them). Inline SQL because listEvents' filter
  // shape doesn't express OR across (agentId IN set, kind LIKE
  // 'director.%') — splitting into two listEvents calls + merging
  // would re-sort and re-allocate; one SQL is cleaner.
  const agentEvents = readEventsForBundle(agentIds, projectId);

  // Director messages for the project — final state from the
  // projection table.
  const directorMessages = readDirectorMessagesForProject(projectId);

  // Per-agent log tails — human-readable dump alongside the
  // structured event stream. Up to 5000 lines/agent.
  const logsPerAgent = new Map<string, string>();
  for (const a of agents) {
    try {
      logsPerAgent.set(a.id, readAgentLog(a.id, 5000));
    } catch {
      // skip; the event stream still has the per-line entries
    }
  }

  const manifest = {
    bundleFormat: 'orun',
    bundleVersion: 1,
    createdAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    scrubSecrets: opts.scrubSecrets,
    projectId,
    agentCount: agents.length,
    eventCount: agentEvents.length,
    directorMessageCount: directorMessages.length,
    agentIds: agents.map((a) => a.id),
  };

  let zip: AdmZip;
  try {
    zip = new AdmZip();
    zip.addFile(
      'manifest.json',
      Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
    );
    zip.addFile(
      'events.json',
      Buffer.from(scrub(JSON.stringify(agentEvents, null, 2)), 'utf8'),
    );
    zip.addFile(
      'agents.json',
      Buffer.from(scrub(JSON.stringify(agents, null, 2)), 'utf8'),
    );
    zip.addFile(
      'director-messages.json',
      Buffer.from(scrub(JSON.stringify(directorMessages, null, 2)), 'utf8'),
    );
    for (const [agentId, log] of logsPerAgent) {
      zip.addFile(
        `logs/${agentId}.log`,
        Buffer.from(scrub(log), 'utf8'),
      );
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'zip build failed',
    };
  }

  // Output filename: <timestamp>-<n>-runs.orun. Land under
  // userData/exports/ so the user can find prior bundles.
  const outDir = path.join(app.getPath('userData'), 'exports');
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch {
    // best-effort
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName =
    agents.length === 1
      ? `${stamp}-${agents[0].name}.orun`
      : `${stamp}-${agents.length}-runs.orun`;
  const outPath = path.join(outDir, fileName);
  try {
    zip.writeZip(outPath);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'zip write failed',
    };
  }

  return { ok: true, path: outPath };
}

function readEventsForBundle(
  agentIds: string[],
  projectId: string,
): EventRow[] {
  const db = getDb();
  const placeholders = agentIds.map(() => '?').join(', ');
  // The UNION captures both (a) every event tagged with one of the
  // requested agentIds and (b) every director.* event in the
  // project — so a bundle for one or more agents includes the plan
  // / message context that surrounded them.
  const sql =
    `SELECT seq, project_id, agent_id, ts, kind, body, schema_v
       FROM events
      WHERE agent_id IN (${placeholders})
   UNION
     SELECT seq, project_id, agent_id, ts, kind, body, schema_v
       FROM events
      WHERE project_id = ?
        AND kind LIKE 'director.%'
      ORDER BY seq ASC`;
  const params: (string | number)[] = [...agentIds, projectId];
  const stmt = db.prepare(sql);
  stmt.bind(params);
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

function readAgentsByIds(ids: string[]): BundleAgentRow[] {
  const db = getDb();
  const placeholders = ids.map(() => '?').join(', ');
  const res = db.exec(
    `SELECT id, project_id, role, role_label, name, status, status_label,
            step, task, tokens, cost, elapsed, model, effort, workspace,
            started_at, ended_at, spawned_by, forked_from_id, forked_from_name,
            provider, subtype, model_usage
       FROM agents
      WHERE id IN (${placeholders})
      ORDER BY started_at ASC`,
    ids,
  );
  if (res.length === 0) return [];
  return res[0].values.map((row) => {
    const modelUsageRaw = row[22];
    let modelUsage: unknown = null;
    if (typeof modelUsageRaw === 'string' && modelUsageRaw.length > 0) {
      try {
        modelUsage = JSON.parse(modelUsageRaw);
      } catch {
        modelUsage = null;
      }
    }
    return {
      id: typeof row[0] === 'string' ? row[0] : '',
      projectId: typeof row[1] === 'string' ? row[1] : '',
      role: typeof row[2] === 'string' ? row[2] : '',
      roleLabel: typeof row[3] === 'string' ? row[3] : '',
      name: typeof row[4] === 'string' ? row[4] : '',
      status: typeof row[5] === 'string' ? row[5] : '',
      statusLabel: typeof row[6] === 'string' ? row[6] : '',
      step: typeof row[7] === 'string' ? row[7] : '',
      task: typeof row[8] === 'string' ? row[8] : '',
      tokens: typeof row[9] === 'number' ? row[9] : 0,
      cost: typeof row[10] === 'number' ? row[10] : 0,
      elapsed: typeof row[11] === 'string' ? row[11] : '',
      model: typeof row[12] === 'string' ? row[12] : '',
      effort: typeof row[13] === 'string' ? row[13] : '',
      workspace: typeof row[14] === 'string' ? row[14] : '',
      startedAt: typeof row[15] === 'number' ? row[15] : 0,
      endedAt: typeof row[16] === 'number' ? row[16] : null,
      spawnedBy: typeof row[17] === 'string' ? row[17] : '',
      forkedFromId: typeof row[18] === 'string' ? row[18] : null,
      forkedFromName: typeof row[19] === 'string' ? row[19] : null,
      provider: typeof row[20] === 'string' ? row[20] : null,
      subtype: typeof row[21] === 'string' ? row[21] : null,
      modelUsage,
    };
  });
}

function readDirectorMessagesForProject(
  projectId: string,
): BundleDirectorMessage[] {
  const db = getDb();
  const res = db.exec(
    `SELECT id, who, name, time, body, plan, redirect, prd,
            plan_accepted, redirect_fired
       FROM director_messages
      WHERE project_id = ?
      ORDER BY ordering ASC`,
    [projectId],
  );
  if (res.length === 0) return [];
  return res[0].values.map((row) => ({
    id: typeof row[0] === 'string' ? row[0] : '',
    who: typeof row[1] === 'string' ? row[1] : '',
    name: typeof row[2] === 'string' ? row[2] : '',
    time: typeof row[3] === 'string' ? row[3] : '',
    body: typeof row[4] === 'string' ? row[4] : '',
    plan: tryJsonParse(row[5]),
    redirect: tryJsonParse(row[6]),
    prd: tryJsonParse(row[7]),
    planAccepted: typeof row[8] === 'number' ? row[8] : 0,
    redirectFired: typeof row[9] === 'number' ? row[9] : 0,
  }));
}

function readAgentLog(agentId: string, limit: number): string {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(limit, 50_000));
  const res = db.exec(
    `SELECT ts, kind, msg FROM log_lines
       WHERE agent_id = ?
       ORDER BY seq ASC
       LIMIT ?`,
    [agentId, safeLimit],
  );
  if (res.length === 0) return '';
  const lines: string[] = [];
  for (const row of res[0].values) {
    const ts = typeof row[0] === 'string' ? row[0] : '';
    const kind = typeof row[1] === 'string' ? row[1] : '';
    const msg = typeof row[2] === 'string' ? row[2] : '';
    lines.push(`[${ts}] ${kind}: ${msg}`);
  }
  return lines.join('\n');
}

function tryJsonParse(v: unknown): unknown {
  if (typeof v !== 'string' || v.length === 0) return null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}
