import fs from 'node:fs';
import path from 'node:path';
import type { SkillKey } from '../shared/types';
import { DEFAULT_SKILLS } from '../shared/defaultSkills';
import { getProject } from './projects';
import { loadClaudeCodeMemorySection } from './claudeCodeMemory';

const ALL_SKILL_KEYS: SkillKey[] = [
  'director',
  'pm',
  'researcher',
  'coder',
  'qa',
  'devops',
  'security',
];

/**
 * Path resolution for `<workspace>/.orchestrator/skills/<key>.md`.
 * Returns null when the project has no workspace set yet — skill files
 * have to live somewhere on disk, so a workspace-less project just gets
 * the built-in defaults until the user picks a folder.
 *
 * `key` is either an AgentRole or 'director'.
 */
function skillPathFor(projectId: string, key: SkillKey): string | null {
  const project = getProject(projectId);
  if (!project?.workspace) return null;
  return path.join(project.workspace, '.orchestrator', 'skills', `${key}.md`);
}

export interface SkillEntry {
  /** AgentRole or 'director'. */
  key: SkillKey;
  /** What the editor/UI shows — disk content if present, otherwise the default. */
  content: string;
  /** Whether the disk file exists (vs falling back to the built-in default). */
  hasFile: boolean;
  /** Absolute path where the file would be / is, for the UI to surface. */
  path: string | null;
}

export function listSkills(projectId: string): SkillEntry[] {
  return ALL_SKILL_KEYS.map((key) => readSkill(projectId, key));
}

export function readSkill(projectId: string, key: SkillKey): SkillEntry {
  const p = skillPathFor(projectId, key);
  if (!p) {
    return {
      key,
      content: DEFAULT_SKILLS[key],
      hasFile: false,
      path: null,
    };
  }
  if (!fs.existsSync(p)) {
    return { key, content: DEFAULT_SKILLS[key], hasFile: false, path: p };
  }
  let content = '';
  try {
    content = fs.readFileSync(p, 'utf8');
  } catch {
    return { key, content: DEFAULT_SKILLS[key], hasFile: false, path: p };
  }
  return { key, content, hasFile: true, path: p };
}

/**
 * Write a key's skill file. An empty string creates an empty file, which
 * explicitly opts out of the built-in default for this project. If the file
 * is deleted outside the app, the loader falls back to the default again.
 *
 * Returns the same shape as readSkill so the UI can refresh state in
 * one round-trip.
 */
export function writeSkill(
  projectId: string,
  key: SkillKey,
  content: string,
): SkillEntry {
  const p = skillPathFor(projectId, key);
  if (!p) {
    throw new Error(
      'Cannot write skills: this project has no workspace folder. Set one in the topbar first.',
    );
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return { key, content, hasFile: true, path: p };
}

/**
 * Server-side read used at spawn time. Returns the effective skill body
 * (disk content if present, default if not) — empty string if neither.
 *
 * F16: also pulls in Claude Code's per-project memory (when present)
 * and appends it as a labelled section. Only `project` and `reference`
 * memory types make it through — `user` (about the user) and
 * `feedback` (about the assistant) would confuse agents. No-op when
 * the workspace has no Claude Code memory dir.
 */
export function effectiveSkill(projectId: string, key: SkillKey): string {
  const base = readSkill(projectId, key).content;
  const project = getProject(projectId);
  if (!project?.workspace) return base;
  const memorySection = loadClaudeCodeMemorySection(project.workspace);
  return memorySection ? base + memorySection : base;
}
