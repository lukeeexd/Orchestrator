import { randomUUID } from 'node:crypto';
import type { EffortLevel, Project } from '../shared/types';
import { isEffortLevel } from '../shared/efforts';
import { getDb, scheduleSave } from './db';

function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asInt(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : fallback;
}

export function listProjects(): Project[] {
  const db = getDb();
  const res = db.exec(
    `SELECT id, name, workspace, created_at, director_model, director_effort FROM projects ORDER BY created_at ASC`,
  );
  if (res.length === 0) return [];
  return res[0].values.map((row) => {
    const dm = row[4];
    const de = row[5];
    return {
      id: asStr(row[0]),
      name: asStr(row[1]),
      workspace: asStr(row[2]),
      createdAt: asInt(row[3]),
      directorModel: typeof dm === 'string' && dm.length > 0 ? dm : undefined,
      directorEffort: isEffortLevel(de) ? de : undefined,
    };
  });
}

export function getProject(id: string): Project | null {
  return listProjects().find((p) => p.id === id) ?? null;
}

export function setProjectDirectorModel(id: string, model: string): void {
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE projects SET director_model = ? WHERE id = ?`,
  );
  stmt.run([model.trim() || null, id]);
  stmt.free();
  scheduleSave();
}

export function setProjectDirectorEffort(
  id: string,
  effort: EffortLevel | null,
): void {
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE projects SET director_effort = ? WHERE id = ?`,
  );
  stmt.run([effort && isEffortLevel(effort) ? effort : null, id]);
  stmt.free();
  scheduleSave();
}

export function createProject(name: string, workspace: string): Project {
  const db = getDb();
  const project: Project = {
    id: randomUUID(),
    name: name.trim() || 'Untitled',
    workspace: workspace.trim(),
    createdAt: Date.now(),
  };
  const stmt = db.prepare(
    `INSERT INTO projects (id, name, workspace, created_at) VALUES (?, ?, ?, ?)`,
  );
  stmt.run([project.id, project.name, project.workspace, project.createdAt]);
  stmt.free();
  scheduleSave();
  return project;
}

export function renameProject(id: string, name: string): void {
  const db = getDb();
  const stmt = db.prepare(`UPDATE projects SET name = ? WHERE id = ?`);
  stmt.run([name.trim() || 'Untitled', id]);
  stmt.free();
  scheduleSave();
}

export function setProjectWorkspace(id: string, workspace: string): void {
  const db = getDb();
  const stmt = db.prepare(`UPDATE projects SET workspace = ? WHERE id = ?`);
  stmt.run([workspace, id]);
  stmt.free();
  scheduleSave();
}

export function deleteProject(id: string): void {
  const db = getDb();
  // Cascade by hand — sql.js doesn't run ON DELETE CASCADE for us reliably
  // and our v6 schema didn't declare it.
  const ds = [
    `DELETE FROM agents WHERE project_id = ?`,
    `DELETE FROM director_messages WHERE project_id = ?`,
    `DELETE FROM log_lines WHERE agent_id IN (SELECT id FROM agents WHERE project_id = ?)`,
    `DELETE FROM kv WHERE key = 'project:' || ? || ':director_session_id'`,
    `DELETE FROM projects WHERE id = ?`,
  ];
  for (const sql of ds) {
    const s = db.prepare(sql);
    s.run([id]);
    s.free();
  }
  scheduleSave();
}

export function getActiveProjectId(): string | null {
  const db = getDb();
  const res = db.exec(`SELECT value FROM kv WHERE key = 'active_project_id'`);
  if (res.length === 0 || res[0].values.length === 0) return null;
  const v = res[0].values[0][0];
  return typeof v === 'string' ? v : null;
}

export function setActiveProjectId(id: string): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO kv (key, value) VALUES ('active_project_id', ?)`,
  );
  stmt.run([id]);
  stmt.free();
  scheduleSave();
}

/**
 * On first launch, make sure at least one project exists. Returns the id of
 * the project that's now active (newly-created or whatever was already set).
 */
export function ensureDefaultProject(): string {
  const existing = listProjects();
  if (existing.length > 0) {
    const active = getActiveProjectId();
    if (active && existing.some((p) => p.id === active)) return active;
    setActiveProjectId(existing[0].id);
    return existing[0].id;
  }
  const fresh = createProject('Default', '');
  setActiveProjectId(fresh.id);
  return fresh.id;
}
