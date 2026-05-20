import fs from 'node:fs';
import path from 'node:path';
import { getProject } from '../projects';

/**
 * Workspace validation at the IPC boundary.
 *
 * Why: `req.workspace` is passed straight through to
 * `child_process.spawn`'s `cwd`, and the CLI then runs with
 * `--permission-mode bypassPermissions` (claude) or `--sandbox
 * workspace-write` (codex). Without validation a compromised
 * renderer could redirect a spawn into `C:\`, `C:\Users\<user>`,
 * `%TEMP%`, or a UNC mount and the agent would happily edit files
 * there.
 *
 * Defenses, in order:
 *   1. Reject obviously dangerous path shapes (empty, UNC,
 *      device-namespace, home-relative, root-drive).
 *   2. Confirm the path exists as a directory (no point spawning
 *      into a non-existent target — also blocks pre-create races
 *      against junction-redirected names).
 *   3. For agent-spawn handlers specifically: confirm the request's
 *      workspace exactly matches the project's stored workspace.
 *      The renderer has no business overriding it per-spawn.
 *
 * Renderer-driven `setProjectWorkspace` calls (1) and (2) but not
 * (3) — that's the entry point where the workspace is being set,
 * so there's nothing to compare against.
 */

export class WorkspaceRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceRejected';
  }
}

function caseInsensitiveOnWin(a: string, b: string): boolean {
  if (process.platform === 'win32') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/**
 * Run the shape + existence checks on a workspace path. Returns the
 * normalized absolute path. Throws WorkspaceRejected on any failure.
 */
export function assertValidWorkspacePath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new WorkspaceRejected('workspace path missing');
  }
  if (raw.startsWith('~')) {
    throw new WorkspaceRejected('home-relative path not allowed');
  }
  // Device namespace (\\?\, \\.\) bypasses normal Win32 path
  // resolution and can also target raw devices. Forbid.
  if (raw.startsWith('\\\\?\\') || raw.startsWith('\\\\.\\')) {
    throw new WorkspaceRejected('device-namespace path not allowed');
  }
  // UNC: \\server\share. Reject — we don't want spawns crossing
  // network boundaries based on whatever the renderer passed.
  if (raw.startsWith('\\\\') || raw.startsWith('//')) {
    throw new WorkspaceRejected('UNC path not allowed');
  }
  const norm = path.normalize(raw);
  if (!path.isAbsolute(norm)) {
    throw new WorkspaceRejected('workspace must be an absolute path');
  }
  // Reject root-only paths. path.parse('C:\\') gives {root:'C:\\', dir:'C:\\', base:''}.
  const parsed = path.parse(norm);
  if (parsed.base === '' && parsed.dir === parsed.root) {
    throw new WorkspaceRejected('root-only paths not allowed');
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(norm);
  } catch {
    throw new WorkspaceRejected('workspace does not exist');
  }
  if (!stat.isDirectory()) {
    throw new WorkspaceRejected('workspace is not a directory');
  }
  return norm;
}

/**
 * For agent-spawn entry points: confirm `workspace` matches the
 * project's stored workspace (after normalization). Per-spawn
 * overrides are by design impossible — the workspace is a project
 * property, not a request property.
 */
export function assertWorkspaceMatchesProject(
  projectId: string,
  workspace: unknown,
): string {
  const project = getProject(projectId);
  if (!project) {
    throw new WorkspaceRejected('unknown project');
  }
  const validated = assertValidWorkspacePath(workspace);
  const stored = assertValidWorkspacePath(project.workspace);
  if (!caseInsensitiveOnWin(path.resolve(validated), path.resolve(stored))) {
    throw new WorkspaceRejected(
      'workspace does not match the project workspace',
    );
  }
  return validated;
}
