import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { readSkill, writeSkill } from './skills';
import type {
  AgentRole,
  MemoryProposal,
  MemoryProposalStatus,
} from '../shared/types';

/**
 * Option-A memory: agents propose pins via the orchestrator-memory
 * fenced block, the user approves from the Drawer's Memory tab,
 * approved pins get appended to the per-role skill file (P4 storage)
 * so subsequent spawns see them through the existing prompt
 * composition path.
 *
 * Schema lives in migration v23 (`memory_proposals` table). This
 * module is the only place that touches it.
 */

const ROLE_VALUES = new Set<AgentRole>([
  'pm',
  'researcher',
  'coder',
  'qa',
  'devops',
  'security',
]);

function isRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && ROLE_VALUES.has(value as AgentRole);
}

function isStatus(value: unknown): value is MemoryProposalStatus {
  return value === 'pending' || value === 'approved' || value === 'rejected';
}

/**
 * Insert a new proposal. The body must be non-empty after trim;
 * empty proposals are silently dropped to keep the Memory tab from
 * filling with noise when an agent emits an empty
 * `orchestrator-memory` block by mistake.
 */
export function recordProposal(input: {
  projectId: string;
  role: AgentRole;
  body: string;
  sourceAgentId?: string;
  sourceAgentName?: string;
}): MemoryProposal | null {
  const body = input.body.trim();
  if (!body) return null;
  const proposal: MemoryProposal = {
    id: randomUUID(),
    projectId: input.projectId,
    role: input.role,
    body,
    ...(input.sourceAgentId ? { sourceAgentId: input.sourceAgentId } : {}),
    ...(input.sourceAgentName ? { sourceAgentName: input.sourceAgentName } : {}),
    createdAt: Date.now(),
    status: 'pending',
  };
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO memory_proposals
      (id, project_id, role, body, source_agent_id, source_agent_name, created_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run([
    proposal.id,
    proposal.projectId,
    proposal.role,
    proposal.body,
    proposal.sourceAgentId ?? null,
    proposal.sourceAgentName ?? null,
    proposal.createdAt,
    proposal.status,
  ]);
  stmt.free();
  return proposal;
}

/**
 * List proposals for a project. The Memory tab calls this filtered
 * by role + status='pending' to render the approval queue.
 * Most recent first.
 */
export function listProposals(filters: {
  projectId: string;
  role?: AgentRole;
  status?: MemoryProposalStatus;
}): MemoryProposal[] {
  const db = getDb();
  const clauses: string[] = ['project_id = ?'];
  const values: (string | number)[] = [filters.projectId];
  if (filters.role) {
    clauses.push('role = ?');
    values.push(filters.role);
  }
  if (filters.status) {
    clauses.push('status = ?');
    values.push(filters.status);
  }
  const sql = `
    SELECT id, project_id, role, body, source_agent_id, source_agent_name, created_at, status
    FROM memory_proposals
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC
  `;
  const result = db.exec(sql, values);
  if (result.length === 0) return [];
  const out: MemoryProposal[] = [];
  for (const row of result[0].values) {
    if (!isRole(row[2])) continue;
    if (!isStatus(row[7])) continue;
    const sourceAgentId = typeof row[4] === 'string' ? row[4] : undefined;
    const sourceAgentName = typeof row[5] === 'string' ? row[5] : undefined;
    out.push({
      id: String(row[0]),
      projectId: String(row[1]),
      role: row[2],
      body: String(row[3]),
      ...(sourceAgentId ? { sourceAgentId } : {}),
      ...(sourceAgentName ? { sourceAgentName } : {}),
      createdAt: typeof row[6] === 'number' ? row[6] : 0,
      status: row[7],
    });
  }
  return out;
}

function getProposal(id: string): MemoryProposal | null {
  const db = getDb();
  const result = db.exec(
    `SELECT id, project_id, role, body, source_agent_id, source_agent_name, created_at, status
     FROM memory_proposals WHERE id = ?`,
    [id],
  );
  if (result.length === 0 || result[0].values.length === 0) return null;
  const row = result[0].values[0];
  if (!isRole(row[2]) || !isStatus(row[7])) return null;
  const sourceAgentId = typeof row[4] === 'string' ? row[4] : undefined;
  const sourceAgentName = typeof row[5] === 'string' ? row[5] : undefined;
  return {
    id: String(row[0]),
    projectId: String(row[1]),
    role: row[2],
    body: String(row[3]),
    ...(sourceAgentId ? { sourceAgentId } : {}),
    ...(sourceAgentName ? { sourceAgentName } : {}),
    createdAt: typeof row[6] === 'number' ? row[6] : 0,
    status: row[7],
  };
}

function setStatus(id: string, status: MemoryProposalStatus): void {
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE memory_proposals SET status = ? WHERE id = ?`,
  );
  stmt.run([status, id]);
  stmt.free();
}

/**
 * Approve a proposal: append the body to the per-role skill file
 * (which is what the existing `effectiveSkill` path reads at spawn
 * time), then mark the row approved.
 *
 * The append format includes a tiny header so the file remains
 * readable when multiple memories accrue. Empty pre-existing skill
 * content gets a clean start; otherwise we insert a blank line +
 * the header.
 */
export function approveProposal(
  id: string,
): { ok: true; proposal: MemoryProposal } | { ok: false; error: string } {
  const proposal = getProposal(id);
  if (!proposal) return { ok: false, error: 'Proposal not found.' };
  if (proposal.status !== 'pending') {
    return { ok: false, error: `Proposal is already ${proposal.status}.` };
  }
  try {
    const current = readSkill(proposal.projectId, proposal.role).content;
    const stamp = new Date(proposal.createdAt).toISOString().slice(0, 10);
    const provenance = proposal.sourceAgentName
      ? `from ${proposal.sourceAgentName}, ${stamp}`
      : stamp;
    const block = `## Memory pin (${provenance})\n\n${proposal.body}\n`;
    const next = current.trim()
      ? `${current.replace(/\s+$/, '')}\n\n${block}`
      : block;
    writeSkill(proposal.projectId, proposal.role, next);
    setStatus(id, 'approved');
    return {
      ok: true,
      proposal: { ...proposal, status: 'approved' },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Reject a proposal: mark it rejected, don't touch the per-role skill. */
export function rejectProposal(
  id: string,
): { ok: true; proposal: MemoryProposal } | { ok: false; error: string } {
  const proposal = getProposal(id);
  if (!proposal) return { ok: false, error: 'Proposal not found.' };
  if (proposal.status !== 'pending') {
    return { ok: false, error: `Proposal is already ${proposal.status}.` };
  }
  setStatus(id, 'rejected');
  return { ok: true, proposal: { ...proposal, status: 'rejected' } };
}
