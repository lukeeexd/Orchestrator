import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export interface WorktreeResult {
  /** Absolute path the agent should cwd into. */
  workdir: string;
  /** True if a git worktree was created; false if we fell back to the workspace itself. */
  isWorktree: boolean;
  /** Branch name (only when isWorktree). */
  branch?: string;
}

function isGitRepo(workspace: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: workspace,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a per-agent git worktree under <workspace>/.orchestrator-worktrees/<agentName>/.
 * If the workspace isn't a git repo, fall back to using it directly.
 */
export function createWorktree(
  workspace: string,
  agentName: string,
): WorktreeResult {
  if (!isGitRepo(workspace)) {
    return { workdir: workspace, isWorktree: false };
  }

  const wtRoot = path.join(workspace, '.orchestrator-worktrees');
  fs.mkdirSync(wtRoot, { recursive: true });

  const workdir = path.join(wtRoot, agentName);
  const branch = `orchestrator/${agentName}`;

  if (fs.existsSync(workdir)) {
    return { workdir, isWorktree: true, branch };
  }

  execSync(
    `git worktree add -b "${branch}" "${workdir}"`,
    { cwd: workspace, stdio: 'pipe' },
  );

  return { workdir, isWorktree: true, branch };
}

/**
 * Tear down a worktree. Safe to call on a non-worktree (no-op).
 */
export function pruneWorktree(workspace: string, workdir: string): void {
  if (!isGitRepo(workspace)) return;
  try {
    execSync(`git worktree remove --force "${workdir}"`, {
      cwd: workspace,
      stdio: 'ignore',
    });
  } catch {
    // best-effort
  }
}
