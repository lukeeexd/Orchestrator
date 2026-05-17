import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { SlashCommand } from '../shared/commands';
import { parseSlashCommandFile } from '../shared/commands';
import { getProject } from './projects';

/**
 * Walk a `.claude/commands/` directory and return every `.md` file as a
 * parsed SlashCommand. Returns [] if the dir doesn't exist (no error).
 */
function scanCommandsDir(
  dir: string,
  scope: SlashCommand['scope'],
): SlashCommand[] {
  if (!fs.existsSync(dir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SlashCommand[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    const name = entry.name.slice(0, -3);
    const fullPath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }
    const cmd = parseSlashCommandFile(name, content, scope, fullPath);
    if (cmd) out.push(cmd);
  }
  return out;
}

/**
 * Resolve every slash command available to a project. Mirrors Claude
 * Code's precedence: project-scoped (`<workspace>/.claude/commands/`)
 * shadows user-scoped (`~/.claude/commands/`) when names collide. We
 * preserve both and let the renderer de-dupe — the project entry wins.
 *
 * Built-in commands are appended last; their names are reserved so a
 * user can't override e.g. `/clear` from disk.
 */
export function listSlashCommands(projectId: string | null): SlashCommand[] {
  const project = projectId ? getProject(projectId) : null;
  const homeDir = app.getPath('home');

  const userDir = path.join(homeDir, '.claude', 'commands');
  const projectDir = project?.workspace
    ? path.join(project.workspace, '.claude', 'commands')
    : null;

  const userCmds = scanCommandsDir(userDir, 'user');
  const projectCmds = projectDir ? scanCommandsDir(projectDir, 'project') : [];

  // Project shadows user on name collision (matches Claude Code semantics).
  const byName = new Map<string, SlashCommand>();
  for (const c of userCmds) byName.set(c.name, c);
  for (const c of projectCmds) byName.set(c.name, c);

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
