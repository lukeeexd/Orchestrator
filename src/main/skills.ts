import fs from 'node:fs';
import path from 'node:path';
import type { AgentRole } from '../shared/types';
import { DEFAULT_SKILLS } from '../shared/defaultSkills';
import { getProject } from './projects';

const ALL_ROLES: AgentRole[] = [
  'pm',
  'researcher',
  'coder',
  'qa',
  'devops',
  'security',
];

/**
 * Path resolution for `<workspace>/.orchestrator/skills/<role>.md`.
 * Returns null when the project has no workspace set yet — skill files
 * have to live somewhere on disk, so a workspace-less project just gets
 * the built-in defaults until the user picks a folder.
 */
function skillPathFor(
  projectId: string,
  role: AgentRole,
): string | null {
  const project = getProject(projectId);
  if (!project?.workspace) return null;
  return path.join(project.workspace, '.orchestrator', 'skills', `${role}.md`);
}

export interface SkillEntry {
  role: AgentRole;
  /** What the editor/UI shows — disk content if present, otherwise the default. */
  content: string;
  /** Whether the disk file exists (vs falling back to the built-in default). */
  hasFile: boolean;
  /** Absolute path where the file would be / is, for the UI to surface. */
  path: string | null;
}

export function listSkills(projectId: string): SkillEntry[] {
  return ALL_ROLES.map((role) => readSkill(projectId, role));
}

export function readSkill(projectId: string, role: AgentRole): SkillEntry {
  const p = skillPathFor(projectId, role);
  if (!p) {
    return {
      role,
      content: DEFAULT_SKILLS[role],
      hasFile: false,
      path: null,
    };
  }
  if (!fs.existsSync(p)) {
    return { role, content: DEFAULT_SKILLS[role], hasFile: false, path: p };
  }
  let content = '';
  try {
    content = fs.readFileSync(p, 'utf8');
  } catch {
    return { role, content: DEFAULT_SKILLS[role], hasFile: false, path: p };
  }
  return { role, content, hasFile: true, path: p };
}

/**
 * Write a role's skill file. An empty string deletes the file — that's
 * the user explicitly opting OUT of the built-in default, signaling
 * "no skill for this role here." Restoring the default is just clearing
 * the field and saving (which deletes), then the loader falls back.
 *
 * Returns the same shape as readSkill so the UI can refresh state in
 * one round-trip.
 */
export function writeSkill(
  projectId: string,
  role: AgentRole,
  content: string,
): SkillEntry {
  const p = skillPathFor(projectId, role);
  if (!p) {
    throw new Error(
      'Cannot write skills: this project has no workspace folder. Set one in the topbar first.',
    );
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (content.length === 0) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return { role, content: DEFAULT_SKILLS[role], hasFile: false, path: p };
  }
  fs.writeFileSync(p, content, 'utf8');
  return { role, content, hasFile: true, path: p };
}

/**
 * Server-side read used at spawn time. Returns the effective skill body
 * (disk content if present, default if not) — empty string if neither.
 * Pure helper; no UI flow, just the runtime resolution the spawn paths
 * need.
 */
export function effectiveSkill(projectId: string, role: AgentRole): string {
  return readSkill(projectId, role).content;
}
