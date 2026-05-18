import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { getDb, scheduleSave } from './db';

/**
 * One row from a marketplace's `.claude-plugin/marketplace.json::plugins`.
 * Mirrors only the fields we actually use; ignores extras like author /
 * keywords / etc. (the renderer can re-read raw if it wants to surface
 * those, but the runner doesn't need them).
 */
export interface BundleManifest {
  /** Stable id from marketplace.json::plugins[].name. */
  id: string;
  /** Relative path from the repo root (e.g. './engineering-team'). */
  source: string;
  description: string;
  version: string;
  category?: string;
  keywords?: string[];
}

/**
 * One configured marketplace source. Persisted in the skill_sources
 * table; the cache module operates on this shape.
 */
export interface SkillSourceRow {
  id: string;
  repo: string;
  defaultBranch: string;
  enabled: boolean;
  addedAt: number;
  lastSyncAt: number | null;
  lastSyncSha: string | null;
}

/**
 * Sanitize an arbitrary id (typically a GitHub `owner/repo` slug) into
 * a filesystem-safe directory name. Two ids that differ only in
 * non-alphanumeric characters can collide here — fine for our case
 * since source ids are repo slugs that already follow GitHub's
 * naming rules.
 */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9.\-_]/g, '--');
}

/** Returns the on-disk cache directory for a given source. */
export function sourceDir(sourceId: string): string {
  return path.join(
    app.getPath('userData'),
    'skill-marketplaces',
    sanitizeId(sourceId),
  );
}

/** Path to the source's marketplace.json (may not exist if never synced). */
export function marketplaceJsonPath(sourceId: string): string {
  return path.join(sourceDir(sourceId), '.claude-plugin', 'marketplace.json');
}

/**
 * Resolve a bundle to the directory we'll pass to `claude --plugin-dir`.
 * Each bundle's `source` field is a relative path from the repo root
 * (e.g. './engineering-team'). The plugin dir is that bundle's root —
 * Claude Code finds the `.claude-plugin/` subfolder beneath.
 */
export function bundlePluginDir(
  sourceId: string,
  bundle: BundleManifest,
): string {
  const rel = bundle.source.replace(/^\.[/\\]/, '');
  return path.join(sourceDir(sourceId), rel);
}

/**
 * Run `git` with the given args and return stdout (or throw on
 * non-zero exit, with stderr in the error message). Used for clone /
 * fetch / reset / rev-parse — all of which we want to fail loudly.
 */
function runGit(
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd: options?.cwd,
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    proc.stdout?.on('data', (c: string) => {
      stdout += c;
    });
    proc.stderr?.on('data', (c: string) => {
      stderr += c;
    });
    proc.on('error', (err) => reject(err));
    const timer = options?.timeoutMs
      ? setTimeout(() => {
          try {
            proc.kill();
          } catch {
            /* ignore */
          }
          reject(new Error(`git ${args[0]} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs)
      : null;
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(
          new Error(
            `git ${args.join(' ')} failed (${code}): ${stderr.trim() || '(no stderr)'}`,
          ),
        );
      }
    });
  });
}

/** Probe `git --version` once at startup. Returns the version string or null. */
export async function probeGit(): Promise<string | null> {
  try {
    return await runGit(['--version'], { timeoutMs: 5000 });
  } catch {
    return null;
  }
}

/**
 * Sync (clone-or-fetch) a marketplace source. First-time sync does a
 * shallow clone (`--depth 1`); subsequent syncs fetch the latest tip
 * of the source's default branch and hard-reset the working tree to
 * it (no local edits to preserve).
 *
 * Returns the new HEAD SHA and a `changed` flag indicating whether
 * anything moved since the last sync — callers use the flag to decide
 * whether to fire "update available" notifications.
 *
 * Throws on git failure / network failure / missing `git` binary; the
 * caller is responsible for surfacing the error.
 */
export async function syncSource(
  source: SkillSourceRow,
): Promise<{ sha: string; changed: boolean }> {
  const dir = sourceDir(source.id);
  const exists = fs.existsSync(path.join(dir, '.git'));

  if (!exists) {
    // Fresh clone. Ensure the parent dir exists; clone --depth 1
    // straight into our managed location.
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    // If the directory exists but isn't a git repo (e.g. partial
    // clone from a previous crash), remove it first so clone has a
    // clean target.
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    await runGit(
      [
        'clone',
        '--depth',
        '1',
        '--branch',
        source.defaultBranch,
        `https://github.com/${source.repo}.git`,
        dir,
      ],
      { timeoutMs: 5 * 60 * 1000 },
    );
    const sha = await runGit(['rev-parse', 'HEAD'], { cwd: dir });
    return { sha, changed: source.lastSyncSha !== sha };
  }

  // Incremental: fetch the tip of the branch (shallow), then hard-reset.
  await runGit(
    ['fetch', '--depth', '1', 'origin', source.defaultBranch],
    { cwd: dir, timeoutMs: 5 * 60 * 1000 },
  );
  await runGit(['reset', '--hard', `origin/${source.defaultBranch}`], {
    cwd: dir,
  });
  const sha = await runGit(['rev-parse', 'HEAD'], { cwd: dir });
  return { sha, changed: source.lastSyncSha !== sha };
}

/**
 * Read and parse a source's marketplace.json. Returns an empty array
 * if the file doesn't exist (source not yet synced) or fails to parse
 * (corrupt cache; the next sync will refresh it). Skips entries that
 * are missing required fields so a single malformed plugin entry
 * doesn't blank the whole list.
 */
export function loadBundles(sourceId: string): BundleManifest[] {
  const p = marketplaceJsonPath(sourceId);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const plugins = (parsed as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) return [];
  const out: BundleManifest[] = [];
  for (const item of plugins) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.name !== 'string' || r.name.length === 0) continue;
    if (typeof r.source !== 'string' || r.source.length === 0) continue;
    if (typeof r.version !== 'string') continue;
    out.push({
      id: r.name,
      source: r.source,
      description:
        typeof r.description === 'string' ? r.description : '',
      version: r.version,
      category: typeof r.category === 'string' ? r.category : undefined,
      keywords: Array.isArray(r.keywords)
        ? (r.keywords.filter((k) => typeof k === 'string') as string[])
        : undefined,
    });
  }
  return out;
}

/**
 * Lookup a single bundle by id within a source. Returns null when the
 * source hasn't been synced yet or the bundle has been removed
 * upstream since the user subscribed. Callers (the runner) skip
 * --plugin-dir for missing bundles rather than aborting the spawn.
 */
export function findBundle(
  sourceId: string,
  bundleId: string,
): BundleManifest | null {
  return loadBundles(sourceId).find((b) => b.id === bundleId) ?? null;
}

// ───────────────────────────── Persistence ─────────────────────────────

function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asInt(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : fallback;
}

function asIntOrNull(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

function asStrOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function listSources(): SkillSourceRow[] {
  const db = getDb();
  const res = db.exec(
    `SELECT id, repo, default_branch, enabled, added_at, last_sync_at, last_sync_sha
     FROM skill_sources ORDER BY added_at ASC`,
  );
  if (res.length === 0) return [];
  return res[0].values.map((row) => ({
    id: asStr(row[0]),
    repo: asStr(row[1]),
    defaultBranch: asStr(row[2]) || 'main',
    enabled: asInt(row[3]) === 1,
    addedAt: asInt(row[4]),
    lastSyncAt: asIntOrNull(row[5]),
    lastSyncSha: asStrOrNull(row[6]),
  }));
}

export function getSource(id: string): SkillSourceRow | null {
  return listSources().find((s) => s.id === id) ?? null;
}

/**
 * Insert a new source row. No-op if a row with the same id already
 * exists — the seed call at startup uses this to make the default
 * source idempotent.
 */
export function ensureSource(row: {
  id: string;
  repo: string;
  defaultBranch?: string;
}): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO skill_sources
       (id, repo, default_branch, enabled, added_at)
     VALUES (?, ?, ?, 1, ?)`,
  );
  stmt.run([
    row.id,
    row.repo,
    row.defaultBranch ?? 'main',
    Date.now(),
  ]);
  stmt.free();
  scheduleSave();
}

export function recordSourceSync(
  id: string,
  sha: string,
  syncedAt: number,
): void {
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE skill_sources SET last_sync_at = ?, last_sync_sha = ? WHERE id = ?`,
  );
  stmt.run([syncedAt, sha, id]);
  stmt.free();
  scheduleSave();
}

export interface ProjectSubscriptionRow {
  projectId: string;
  sourceId: string;
  bundleId: string;
  subscribedAt: number;
  installedVersion: string | null;
  /**
   * Per-role enablement. `null` (or an empty/legacy column) means
   * "all roles" — preserves the pre-v17 behaviour. Otherwise: only
   * the listed roles + 'director' (if present) load the bundle's
   * --plugin-dir.
   */
  roles: string[] | null;
}

function parseRoles(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item === 'string' && item.length > 0) out.push(item);
    }
    return out;
  } catch {
    return null;
  }
}

export function listSubscriptions(
  projectId: string,
): ProjectSubscriptionRow[] {
  const db = getDb();
  const stmt = db.prepare(
    `SELECT project_id, source_id, bundle_id, subscribed_at, installed_version, roles
     FROM project_subscribed_bundles
     WHERE project_id = ?
     ORDER BY subscribed_at ASC`,
  );
  stmt.bind([projectId]);
  const out: ProjectSubscriptionRow[] = [];
  while (stmt.step()) {
    const row = stmt.get();
    out.push({
      projectId: asStr(row[0]),
      sourceId: asStr(row[1]),
      bundleId: asStr(row[2]),
      subscribedAt: asInt(row[3]),
      installedVersion: asStrOrNull(row[4]),
      roles: parseRoles(row[5]),
    });
  }
  stmt.free();
  return out;
}

export function subscribeBundle(
  projectId: string,
  sourceId: string,
  bundleId: string,
  installedVersion: string | null,
): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO project_subscribed_bundles
       (project_id, source_id, bundle_id, subscribed_at, installed_version)
     VALUES (?, ?, ?, ?, ?)`,
  );
  stmt.run([
    projectId,
    sourceId,
    bundleId,
    Date.now(),
    installedVersion,
  ]);
  stmt.free();
  scheduleSave();
}

export function unsubscribeBundle(
  projectId: string,
  sourceId: string,
  bundleId: string,
): void {
  const db = getDb();
  const stmt = db.prepare(
    `DELETE FROM project_subscribed_bundles
     WHERE project_id = ? AND source_id = ? AND bundle_id = ?`,
  );
  stmt.run([projectId, sourceId, bundleId]);
  stmt.free();
  scheduleSave();
}

/**
 * Set the per-role enablement for a subscription. Passing `null`
 * (the default at subscribe time) means "all roles" — preserves the
 * pre-v17 behaviour. Passing an empty array disables the bundle for
 * every role, which subscribes it without using it; the UI surfaces
 * that as a "no agents" hint.
 */
export function setSubscriptionRoles(
  projectId: string,
  sourceId: string,
  bundleId: string,
  roles: string[] | null,
): void {
  const db = getDb();
  const value = roles ? JSON.stringify(roles) : null;
  const stmt = db.prepare(
    `UPDATE project_subscribed_bundles
     SET roles = ?
     WHERE project_id = ? AND source_id = ? AND bundle_id = ?`,
  );
  stmt.run([value, projectId, sourceId, bundleId]);
  stmt.free();
  scheduleSave();
}

/**
 * Mark a subscription as having seen up to a specific bundle version.
 * Used by the "ack update" flow — the next sync that brings in a
 * newer version will re-trigger the update notification.
 */
export function acknowledgeBundleVersion(
  projectId: string,
  sourceId: string,
  bundleId: string,
  version: string,
): void {
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE project_subscribed_bundles
     SET installed_version = ?
     WHERE project_id = ? AND source_id = ? AND bundle_id = ?`,
  );
  stmt.run([version, projectId, sourceId, bundleId]);
  stmt.free();
  scheduleSave();
}

/**
 * Resolve a project's subscriptions to a list of `--plugin-dir`-ready
 * paths the spawn layer can pass to the claude CLI. The `role`
 * parameter (an AgentRole key or 'director') filters out
 * subscriptions whose per-role enablement excludes the spawning
 * agent — `roles: null` always matches (legacy "all roles"), `roles:
 * []` matches nothing (subscribed-but-disabled).
 *
 * Also skips entries whose source hasn't been synced yet OR whose
 * bundle has been removed upstream — the runner shouldn't abort a
 * spawn because the cache is half-baked. Returns paths only for
 * directories that actually exist on disk.
 */
export function pluginDirsForProject(
  projectId: string,
  role: string,
): string[] {
  const subs = listSubscriptions(projectId);
  if (subs.length === 0) return [];
  const out: string[] = [];
  for (const s of subs) {
    if (s.roles !== null && !s.roles.includes(role)) continue;
    const bundle = findBundle(s.sourceId, s.bundleId);
    if (!bundle) continue;
    const dir = bundlePluginDir(s.sourceId, bundle);
    if (fs.existsSync(dir)) out.push(dir);
  }
  return out;
}
