import type { HistoryRow } from '../shared/types';
import { ROLES } from '../shared/roles';
import * as registry from './agents/registry';
import { listProjects } from './projects';

/**
 * Cross-project agent listing for the History screen. The registry is
 * already hydrated with every persisted agent on startup, so this is
 * just an in-memory projection — no DB hit.
 *
 * Returned newest-first so the most-recently-spawned agent surfaces at
 * the top of the table; the renderer adds its own sort affordances.
 */
export function listHistory(): HistoryRow[] {
  const projects = listProjects();
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));

  const rows: HistoryRow[] = [];
  for (const a of registry.list()) {
    rows.push({
      id: a.id,
      name: a.name,
      role: a.role,
      roleLabel: ROLES[a.role]?.label ?? a.role,
      status: a.status,
      statusLabel: a.statusLabel,
      model: a.model,
      task: a.task,
      tokens: a.tokens,
      cost: a.cost,
      startedAt: a.startedAt,
      endedAt: a.endedAt ?? null,
      elapsed: a.elapsed,
      projectId: a.projectId,
      projectName: projectNames.get(a.projectId) ?? '(deleted project)',
      spawnedBy: a.spawnedBy,
      forkedFromName: a.forkedFromName,
    });
  }

  rows.sort((a, b) => b.startedAt - a.startedAt);
  return rows;
}
