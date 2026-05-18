import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type {
  AgentRole,
  EffortLevel,
  Project,
  Provider,
} from '../shared/types';
import { isEffortLevel } from '../shared/efforts';
import { getDb, scheduleSave } from './db';

/**
 * Path to the on-disk mirror of a project's MCP config. The DB stores
 * the JSON string; we sync it to a real file because `claude
 * --mcp-config` reads a path and we don't want to risk Windows' argv
 * length cap with a long inline JSON string.
 */
export function mcpConfigPath(projectId: string): string {
  return path.join(
    app.getPath('userData'),
    'mcp-configs',
    `${projectId}.json`,
  );
}

/**
 * Returns the on-disk MCP config path for a project IF a config has
 * been saved, else null. Runner callers use this to decide whether to
 * pass --mcp-config to the CLI.
 */
export function getMcpConfigPath(projectId: string): string | null {
  const p = mcpConfigPath(projectId);
  try {
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

function asProvider(v: unknown): Provider {
  return v === 'codex' ? 'codex' : 'claude';
}

function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asInt(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : fallback;
}

export function listProjects(): Project[] {
  const db = getDb();
  const res = db.exec(
    `SELECT id, name, workspace, created_at, director_model, director_effort, role_tools, provider, director_provider, mcp_config FROM projects ORDER BY created_at ASC`,
  );
  if (res.length === 0) return [];
  return res[0].values.map((row) => {
    const dm = row[4];
    const de = row[5];
    const rt = row[6];
    const pv = row[7];
    const dpv = row[8];
    const mcp = row[9];
    return {
      id: asStr(row[0]),
      name: asStr(row[1]),
      workspace: asStr(row[2]),
      createdAt: asInt(row[3]),
      provider: asProvider(pv),
      directorModel: typeof dm === 'string' && dm.length > 0 ? dm : undefined,
      directorEffort: isEffortLevel(de) ? de : undefined,
      directorProvider:
        dpv === 'claude' || dpv === 'codex' ? dpv : undefined,
      roleTools: parseRoleTools(rt),
      mcpConfig: typeof mcp === 'string' && mcp.length > 0 ? mcp : undefined,
    };
  });
}

function parseRoleTools(raw: unknown): Project['roleTools'] {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const out: Partial<Record<AgentRole, string[]>> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
        out[k as AgentRole] = v;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
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

/**
 * Set the project's MCP server config — a JSON string in the shape
 * `claude --mcp-config` expects. Pass null (or empty) to clear. The
 * string is stored in the DB and mirrored to a file in app userData
 * so the CLI can read a real path. Returns the on-disk path that the
 * runner will pass via `--mcp-config`, or null if the config was
 * cleared.
 *
 * Validation is the caller's job: this writes whatever you hand it.
 * The IPC handler does the JSON.parse check before calling.
 */
export function setProjectMcpConfig(
  id: string,
  config: string | null,
): string | null {
  const db = getDb();
  const value = config && config.trim().length > 0 ? config : null;
  const stmt = db.prepare(`UPDATE projects SET mcp_config = ? WHERE id = ?`);
  stmt.run([value, id]);
  stmt.free();
  scheduleSave();

  // Mirror to disk for the CLI to read.
  const filePath = mcpConfigPath(id);
  if (value) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, value, 'utf8');
      return filePath;
    } catch {
      // If the file write fails the DB is still correct; subsequent
      // spawns will skip --mcp-config because the file isn't there.
      return null;
    }
  } else {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // already gone
    }
    return null;
  }
}

/**
 * Set the Director's provider override for a project. Pass `null` (or
 * an invalid value) to clear, returning the Director to the project's
 * default. The caller is responsible for resetting any in-memory and
 * persisted Director session id — switching providers invalidates the
 * existing session id because the new CLI can't resume a session
 * created by the old one.
 */
export function setProjectDirectorProvider(
  id: string,
  provider: Provider | null,
): void {
  const db = getDb();
  const value =
    provider === 'claude' || provider === 'codex' ? provider : null;
  const stmt = db.prepare(
    `UPDATE projects SET director_provider = ? WHERE id = ?`,
  );
  stmt.run([value, id]);
  stmt.free();
  scheduleSave();
}

/**
 * Replace the entire role-tools override map for a project. Passing
 * `null` clears the override so every role falls back to its default
 * tool set. Empty objects are also stored as NULL so a "reset" round-trips
 * cleanly.
 */
export function setProjectRoleTools(
  id: string,
  roleTools: Partial<Record<AgentRole, string[]>> | null,
): void {
  const db = getDb();
  const payload =
    roleTools && Object.keys(roleTools).length > 0
      ? JSON.stringify(roleTools)
      : null;
  const stmt = db.prepare(`UPDATE projects SET role_tools = ? WHERE id = ?`);
  stmt.run([payload, id]);
  stmt.free();
  scheduleSave();
}

export function createProject(
  name: string,
  workspace: string,
  provider: Provider = 'claude',
): Project {
  const db = getDb();
  const project: Project = {
    id: randomUUID(),
    name: name.trim() || 'Untitled',
    workspace: workspace.trim(),
    createdAt: Date.now(),
    provider,
  };
  const stmt = db.prepare(
    `INSERT INTO projects (id, name, workspace, created_at, provider) VALUES (?, ?, ?, ?, ?)`,
  );
  stmt.run([
    project.id,
    project.name,
    project.workspace,
    project.createdAt,
    project.provider,
  ]);
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
    `DELETE FROM log_lines WHERE agent_id IN (SELECT id FROM agents WHERE project_id = ?)`,
    `DELETE FROM agents WHERE project_id = ?`,
    `DELETE FROM director_messages WHERE project_id = ?`,
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
