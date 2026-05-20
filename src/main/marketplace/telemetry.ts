import { getDb, scheduleSave } from '../db';
import { asInt, asStr } from './internal';
import type { LoadoutReport } from './loadout';

export interface SkillFireCount {
  projectId: string;
  role: string;
  sourceId: string;
  bundleId: string;
  skillId: string;
  count: number;
  lastFiredAt: number;
}

/**
 * Increment the fire counter for a skill. Idempotent: each call adds
 * one. The agent runner calls this when it detects an event that
 * almost certainly came from a skill activation (tool_use Read on a
 * SKILL.md, or any tool path falling under a skill's dir).
 */
export function bumpSkillFire(
  projectId: string,
  role: string,
  sourceId: string,
  bundleId: string,
  skillId: string,
): void {
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO skill_fire_counts
       (project_id, role, source_id, bundle_id, skill_id, count, last_fired_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(project_id, role, source_id, bundle_id, skill_id)
     DO UPDATE SET count = count + 1, last_fired_at = excluded.last_fired_at`,
  );
  stmt.run([projectId, role, sourceId, bundleId, skillId, now]);
  stmt.free();
  scheduleSave();
}

/**
 * Read every fire count row for a project (across all roles). The UI
 * groups these client-side by (role, sourceId, bundleId, skillId) when
 * decorating the Agent skills checkboxes.
 */
export function getSkillFireCounts(projectId: string): SkillFireCount[] {
  const db = getDb();
  const stmt = db.prepare(
    `SELECT project_id, role, source_id, bundle_id, skill_id, count, last_fired_at
     FROM skill_fire_counts
     WHERE project_id = ?
     ORDER BY count DESC, last_fired_at DESC`,
  );
  stmt.bind([projectId]);
  const out: SkillFireCount[] = [];
  while (stmt.step()) {
    const row = stmt.get();
    out.push({
      projectId: asStr(row[0]),
      role: asStr(row[1]),
      sourceId: asStr(row[2]),
      bundleId: asStr(row[3]),
      skillId: asStr(row[4]),
      count: asInt(row[5]),
      lastFiredAt: asInt(row[6]),
    });
  }
  stmt.free();
  return out;
}

/**
 * Given a path argument from a tool_use event + a precomputed loadout
 * for the spawning role, return which (sourceId, bundleId, skillId) it
 * belongs to — or `null` if the path doesn't fall inside any of the
 * loadout's skill directories.
 *
 * Match rule: the path string contains
 *   `<entry.pluginDir>/skills/<skillId>`
 * (with either forward or backward slashes, since claude on Windows
 * can produce either). Both the bundle's pluginDir and its skill
 * subdir need to appear so we don't mis-attribute fires from random
 * "skills/" segments elsewhere in the user's filesystem.
 */
export function attributePathToSkill(
  pathArg: string,
  loadout: LoadoutReport,
): { sourceId: string; bundleId: string; skillId: string } | null {
  if (!pathArg) return null;
  // Normalize both the candidate path and the loadout paths to forward
  // slashes for the comparison. We don't mutate either — just compare.
  const normalized = pathArg.replace(/\\/g, '/');
  for (const entry of loadout.entries) {
    if (!entry.pluginDir) continue;
    const dirNorm = entry.pluginDir.replace(/\\/g, '/');
    // Prefer the canonical layout (`<pluginDir>/skills/<id>`) but
    // tolerate the legacy "skill at bundle root" layout too — same
    // fallback that listBundleSkills uses.
    for (const sk of entry.skills) {
      const canonical = `${dirNorm}/skills/${sk.id}`;
      const legacy = `${dirNorm}/${sk.id}`;
      if (
        normalized.startsWith(canonical) ||
        normalized.startsWith(legacy)
      ) {
        return {
          sourceId: entry.sourceId,
          bundleId: entry.bundleId,
          skillId: sk.id,
        };
      }
    }
  }
  return null;
}
