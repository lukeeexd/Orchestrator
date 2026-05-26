import { spawnSync } from 'node:child_process';

/**
 * F14: thin synchronous wrappers around the user's `git` binary,
 * scoped to the project workspace path. All operations are best-
 * effort — a missing `git` binary, a non-repo directory, or any
 * command failure yields a structured result instead of throwing,
 * so the DirectorAcceptPlan handler can decide whether to proceed
 * silently or surface a warning in the Director chat.
 *
 * Keep this file dependency-free (no electron / no db); it's a
 * shell-out leaf module so it can be unit-tested without the
 * Electron harness.
 */

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function run(cwd: string, args: string[]): GitResult {
  try {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    return {
      ok: r.status === 0 && !r.error,
      stdout: (r.stdout ?? '').trim(),
      stderr: (r.stderr ?? '').trim(),
    };
  } catch (e) {
    return { ok: false, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
  }
}

export function isGitRepo(cwd: string): boolean {
  return run(cwd, ['rev-parse', '--is-inside-work-tree']).ok;
}

export function currentBranch(cwd: string): string | null {
  const r = run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!r.ok) return null;
  // Detached HEAD shows up as 'HEAD' — surface as null so callers
  // don't accidentally treat it as a real branch name.
  return r.stdout === 'HEAD' ? null : r.stdout;
}

/**
 * Local branch names in the repo, ordered alphabetically per
 * `git branch`'s default. Returns an empty list when the directory
 * isn't a git repo, so the renderer can treat "no branches" and
 * "not a repo" the same way: skip the base-branch picker.
 */
export function listBranches(
  cwd: string,
): { branches: string[]; current: string | null } {
  if (!isGitRepo(cwd)) return { branches: [], current: null };
  const r = run(cwd, ['branch', '--list', '--format=%(refname:short)']);
  if (!r.ok) return { branches: [], current: currentBranch(cwd) };
  const branches = r.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { branches, current: currentBranch(cwd) };
}

/** True when the working tree or index has uncommitted changes. */
export function hasUncommitted(cwd: string): boolean {
  const r = run(cwd, ['status', '--porcelain']);
  if (!r.ok) return false;
  return r.stdout.length > 0;
}

/** True iff `name` exists as a local branch ref. */
export function branchExists(cwd: string, name: string): boolean {
  return run(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).ok;
}

/**
 * Slugify a free-form string into something safe for a branch name:
 * lowercase ASCII letters, digits, and hyphens; collapsed dashes;
 * trimmed; max-N chars. Empty / all-punctuation input → empty
 * string, which the caller should treat as "no slug, use planId
 * alone".
 */
export function slugify(input: string, max = 40): string {
  const ascii = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii.length === 0) return '';
  return ascii.slice(0, max).replace(/-+$/g, '');
}

/**
 * Compose the F14 branch name from a plan id (any string — typically
 * a UUID from the DirectorMessage) plus a free-form slug source
 * (typically the first plan row's task). Truncates the plan id to 8
 * chars so the branch reads as `orchestrator/<short>-<slug>`.
 * Skipping the slug when empty keeps the branch usable even if the
 * first task is purely non-ASCII.
 */
export function buildBranchName(planId: string, slugSource: string): string {
  const short = planId.replace(/-/g, '').slice(0, 8) || 'plan';
  const slug = slugify(slugSource);
  return slug ? `orchestrator/${short}-${slug}` : `orchestrator/${short}`;
}

export interface EnsureBranchResult {
  ok: boolean;
  branch: string;
  /** True when a new branch was created vs an existing one being checked out. */
  created: boolean;
  /** Set when ok=false. Human-readable reason, suitable for surfacing in chat. */
  reason?: string;
}

/**
 * Create-or-checkout `name`. If the branch already exists (e.g. the
 * user re-accepts the same plan), check it out instead of erroring —
 * that's the idempotent behaviour callers want. Refuses to switch
 * branches when the working tree is dirty: `git checkout` would
 * either complain itself or, worse, carry uncommitted edits onto
 * the new branch.
 *
 * When `baseBranch` is provided AND a NEW branch is being created,
 * the new branch is rooted at `baseBranch` (`git checkout -b <name>
 * <baseBranch>`) instead of inheriting the current HEAD's tree.
 * An existing target branch is left untouched — we never reset its
 * history toward `baseBranch`, since that would discard whatever
 * the agents already committed on a re-accepted plan.
 */
export function ensureBranch(
  cwd: string,
  name: string,
  baseBranch?: string,
): EnsureBranchResult {
  if (!isGitRepo(cwd)) {
    return { ok: false, branch: name, created: false, reason: 'not a git repo' };
  }
  if (hasUncommitted(cwd)) {
    return {
      ok: false,
      branch: name,
      created: false,
      reason: 'uncommitted changes — commit or stash before auto-branching',
    };
  }
  // If we're already on the target branch, nothing to do.
  if (currentBranch(cwd) === name) {
    return { ok: true, branch: name, created: false };
  }
  if (branchExists(cwd, name)) {
    const r = run(cwd, ['checkout', name]);
    if (!r.ok) return { ok: false, branch: name, created: false, reason: r.stderr };
    return { ok: true, branch: name, created: false };
  }
  if (baseBranch && !branchExists(cwd, baseBranch)) {
    return {
      ok: false,
      branch: name,
      created: false,
      reason: `base branch \`${baseBranch}\` not found`,
    };
  }
  const args = baseBranch
    ? ['checkout', '-b', name, baseBranch]
    : ['checkout', '-b', name];
  const r = run(cwd, args);
  if (!r.ok) return { ok: false, branch: name, created: false, reason: r.stderr };
  return { ok: true, branch: name, created: true };
}
