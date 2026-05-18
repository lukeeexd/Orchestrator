import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { app } from 'electron';
import { getDb, scheduleSave } from './db';
import { MARKETPLACE_GLOBAL_SCOPE_ID } from '../shared/ipc';

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
 * Run `tar` (or the system equivalent) with the given args. Used for
 * extracting the GitHub tarball fallback when git isn't available.
 * Windows 10+ ships bsdtar at C:\Windows\System32\tar.exe so this
 * works without a node-tar dependency on every supported platform.
 */
function runTar(
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', args, {
      cwd: options?.cwd,
      shell: false,
      windowsHide: true,
    });
    let stderr = '';
    proc.stderr?.setEncoding('utf8');
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
          reject(new Error(`tar timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs)
      : null;
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `tar ${args.join(' ')} failed (${code}): ${stderr.trim() || '(no stderr)'}`,
          ),
        );
    });
  });
}

interface SyncMethod {
  kind: 'git-clone' | 'git-fetch' | 'tarball';
}

/**
 * GitHub-tarball fallback. Used when git isn't on PATH (or its clone
 * step failed). Downloads `https://codeload.github.com/<owner>/<repo>/
 * tar.gz/<branch>` via the platform's native fetch, streams it to a
 * temp file, extracts via the system `tar`, and atomically replaces
 * the cache dir. Looks up the latest commit SHA via the GitHub API
 * (unauthenticated; rate-limited to 60 requests/hour per IP which is
 * more than enough for our use case).
 */
async function syncSourceViaTarball(
  source: SkillSourceRow,
): Promise<{ sha: string; changed: boolean }> {
  // 1. Resolve the branch's HEAD SHA so we can store it. The
  //    User-Agent header is required by GitHub's API; we send a
  //    generic Orchestrator identifier.
  const apiUrl = `https://api.github.com/repos/${source.repo}/commits/${encodeURIComponent(
    source.defaultBranch,
  )}`;
  const apiResp = await fetch(apiUrl, {
    headers: { 'User-Agent': 'Orchestrator (skill-marketplace)' },
  });
  if (!apiResp.ok) {
    const body = await apiResp.text();
    throw new Error(
      `GitHub API ${apiResp.status} on ${apiUrl}: ${body.slice(0, 200)}`,
    );
  }
  const apiJson = (await apiResp.json()) as { sha?: unknown };
  const sha = typeof apiJson.sha === 'string' ? apiJson.sha : null;
  if (!sha) {
    throw new Error(`GitHub API didn't return a commit SHA for ${source.repo}`);
  }

  // 2. Stream the tarball to a temp file.
  const tarballUrl = `https://codeload.github.com/${source.repo}/tar.gz/${encodeURIComponent(
    source.defaultBranch,
  )}`;
  const tarResp = await fetch(tarballUrl, {
    headers: { 'User-Agent': 'Orchestrator (skill-marketplace)' },
  });
  if (!tarResp.ok || !tarResp.body) {
    throw new Error(
      `tarball fetch ${tarResp.status} on ${tarballUrl}`,
    );
  }
  const tempTar = path.join(
    os.tmpdir(),
    `orchestrator-marketplace-${randomUUID()}.tar.gz`,
  );
  await pipeline(
    Readable.fromWeb(tarResp.body as never),
    fs.createWriteStream(tempTar),
  );

  // 3. Extract to a sibling temp dir, then atomic-replace the cache
  //    dir. We use a temp dir + rename instead of extracting into the
  //    final location so a partial extract from a network failure
  //    doesn't leave a corrupted cache.
  const tempExtract = path.join(
    os.tmpdir(),
    `orchestrator-marketplace-${randomUUID()}-extract`,
  );
  fs.mkdirSync(tempExtract, { recursive: true });
  try {
    await runTar(['-xzf', tempTar, '-C', tempExtract], {
      timeoutMs: 5 * 60 * 1000,
    });

    // GitHub tarballs always have a single top-level dir named
    // <owner>-<repo>-<short-sha>. Move that dir's contents (i.e.
    // rename it) into the cache location.
    const entries = fs.readdirSync(tempExtract);
    if (entries.length !== 1) {
      throw new Error(
        `unexpected tarball layout: ${entries.length} top-level entries`,
      );
    }
    const inner = path.join(tempExtract, entries[0]);
    const dir = sourceDir(source.id);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.renameSync(inner, dir);
  } finally {
    // Best-effort cleanup. The OS temp will reap leftovers anyway.
    try {
      fs.unlinkSync(tempTar);
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tempExtract, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  return { sha, changed: source.lastSyncSha !== sha };
}

async function syncSourceViaGitClone(
  source: SkillSourceRow,
): Promise<{ sha: string; changed: boolean }> {
  const dir = sourceDir(source.id);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  // If the directory exists but isn't a git repo (e.g. partial clone
  // from a previous crash, or a prior tarball install that we're now
  // upgrading), remove it first so clone has a clean target.
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

async function syncSourceViaGitFetch(
  source: SkillSourceRow,
): Promise<{ sha: string; changed: boolean }> {
  const dir = sourceDir(source.id);
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
 * Sync a marketplace source. Strategy:
 *
 * - If the cache dir already has a `.git/` subdir (a previous git
 *   clone), do an incremental `git fetch --depth 1 + git reset --hard`.
 *   Cheapest path; preserves git's delta-transfer benefits.
 * - Otherwise: try a shallow `git clone --depth 1`. If git isn't on
 *   PATH or the clone errors (network glitch, repo issue), fall back
 *   to downloading the GitHub tarball via native fetch + extracting
 *   with the system `tar`. The tarball path never produces a `.git/`
 *   directory, so subsequent syncs for the same source stay on the
 *   tarball path (no incremental, full re-download each time — fine
 *   on broadband, slow on tethered, but at least it works without git
 *   installed).
 *
 * Returns the new HEAD SHA and a `changed` flag the caller uses to
 * decide whether to fire "update available" notifications.
 */
export async function syncSource(
  source: SkillSourceRow,
): Promise<{ sha: string; changed: boolean }> {
  const dir = sourceDir(source.id);
  if (fs.existsSync(path.join(dir, '.git'))) {
    return syncSourceViaGitFetch(source);
  }
  const gitAvailable = (await probeGit()) !== null;
  if (gitAvailable) {
    try {
      return await syncSourceViaGitClone(source);
    } catch (e) {
      // Don't surface yet — the tarball fallback might succeed. We
      // do still log so the user can see the original error via
      // devtools if the fallback also fails (then the tarball error
      // is what bubbles up).
      console.warn(
        `[marketplace] git clone failed for ${source.id}, falling back to tarball:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return syncSourceViaTarball(source);
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

// ───────────────────────────── Changelog ───────────────────────────

/**
 * Best-effort semver compare. Returns -1 / 0 / 1. Tolerant of leading
 * `v`, missing patch component, pre-release suffixes (compared
 * lexically). Not a full semver — good enough for changelog ordering.
 */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v.replace(/^v/, '').split(/[.-]/).map((p) => {
      const n = Number(p);
      return Number.isFinite(n) ? n : p;
    });
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (typeof ai === 'number' && typeof bi === 'number') {
      if (ai !== bi) return ai < bi ? -1 : 1;
    } else {
      const as = String(ai);
      const bs = String(bi);
      if (as !== bs) return as < bs ? -1 : 1;
    }
  }
  return 0;
}

export interface ChangelogEntry {
  /** Version this entry documents (e.g. "2.2.3"). */
  version: string;
  /** Optional ISO date from the heading (e.g. "2024-01-15"). */
  date?: string;
  /** Raw markdown body of the section, with the heading line stripped. */
  body: string;
}

/**
 * Parse a CHANGELOG.md (Keep-a-Changelog style) into version entries.
 * Splits on `## ` H2 headings, extracts a version-looking token from
 * each heading. Anything that doesn't look like a version is dropped.
 * Tolerant of `## [1.2.3]`, `## v1.2.3`, `## 1.2.3 - 2024-01-15`, etc.
 */
function parseChangelog(raw: string): ChangelogEntry[] {
  const out: ChangelogEntry[] = [];
  // ^## (not ###) at start of line.
  const lines = raw.split(/\r?\n/);
  let current: { heading: string; bodyLines: string[] } | null = null;
  const push = () => {
    if (!current) return;
    const m = current.heading.match(/v?(\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.]+)?)/);
    if (!m) {
      current = null;
      return;
    }
    const version = m[1];
    const dateM = current.heading.match(/(\d{4}-\d{2}-\d{2})/);
    out.push({
      version,
      date: dateM?.[1],
      body: current.bodyLines.join('\n').trim(),
    });
    current = null;
  };
  for (const line of lines) {
    if (/^## (?!#)/.test(line)) {
      push();
      current = { heading: line.replace(/^## /, ''), bodyLines: [] };
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  push();
  return out;
}

/**
 * Read a source's CHANGELOG.md (root of the cache dir) and return
 * entries strictly newer than `fromVersion`, up to and including
 * `toVersion`. Returns an empty array if the file doesn't exist, the
 * file doesn't parse, or no entries fall in range.
 *
 * Bundle-level: this scans the source-wide CHANGELOG.md. The
 * alirezarezvani repo (and similar) keep one top-level changelog
 * documenting all bundles at the source level. Per-bundle changelogs
 * (under `<bundle>/CHANGELOG.md`) are not searched here — could be a
 * follow-up if a source uses them.
 */
export function getSourceChangelog(
  sourceId: string,
  fromVersion: string | null,
  toVersion: string,
): ChangelogEntry[] {
  const p = path.join(sourceDir(sourceId), 'CHANGELOG.md');
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  const entries = parseChangelog(raw);
  return entries.filter((e) => {
    if (compareVersions(e.version, toVersion) > 0) return false;
    if (fromVersion && compareVersions(e.version, fromVersion) <= 0) return false;
    return true;
  });
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
 *
 * Returns true if a new row was inserted, false if a row with the
 * same id already existed. Callers building an Add-Source flow use
 * the return to distinguish "duplicate" from "first install".
 */
export function ensureSource(row: {
  id: string;
  repo: string;
  defaultBranch?: string;
}): boolean {
  const existed = !!getSource(row.id);
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
  return !existed;
}

/**
 * Remove a source entirely: every project's subscription that
 * references it, the on-disk cache directory, and the skill_sources
 * row. Best-effort on disk (the OS can clean up tempfile residue
 * later if a rename mid-sync left something locked).
 *
 * Returns true if a row was deleted; false if nothing matched.
 */
export function removeSource(id: string): boolean {
  if (!getSource(id)) return false;
  const db = getDb();
  // 1. Drop subscriptions across every project (and global) — no FK
  //    cascade in our schema, so do it explicitly.
  const subs = db.prepare(
    `DELETE FROM project_subscribed_bundles WHERE source_id = ?`,
  );
  subs.run([id]);
  subs.free();
  // 2. Drop the source row itself.
  const src = db.prepare(`DELETE FROM skill_sources WHERE id = ?`);
  src.run([id]);
  src.free();
  scheduleSave();
  // 3. Best-effort delete of the on-disk clone. Don't throw if
  //    something's locked — the user can clean up manually if so.
  try {
    fs.rmSync(sourceDir(id), { recursive: true, force: true });
  } catch (e) {
    console.error(
      `[marketplace] removeSource(${id}): failed to delete cache dir`,
      e instanceof Error ? e.message : e,
    );
  }
  return true;
}

/**
 * Toggle a source's enabled flag. Disabled sources still exist (cache
 * dir, subscriptions, DB row all stay); they're just ignored by
 * spawn-time --plugin-dir resolution and skipped by the startup sync
 * loop. Re-enabling is instant — no re-clone needed.
 */
export function setSourceEnabled(id: string, enabled: boolean): void {
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE skill_sources SET enabled = ? WHERE id = ?`,
  );
  stmt.run([enabled ? 1 : 0, id]);
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
  /**
   * Skill-level enablement within the bundle. `null` (the default
   * at subscribe time) means "all skills in the bundle". Otherwise
   * a list of skill ids (subdir names containing SKILL.md). When
   * set, the runner builds a synthetic plugin dir containing only
   * the listed skills and passes that to --plugin-dir.
   */
  selectedSkills: string[] | null;
}

/**
 * One skill inside a bundle, as enumerated from disk. Surfaced to the
 * UI so the user can pick which skills to load when subset-installing
 * a bundle.
 */
export interface BundleSkillInfo {
  /** Subdir name inside the bundle (also used as the JSON id). */
  id: string;
  /** Optional human label from SKILL.md frontmatter `name:`. */
  name?: string;
  /** Optional one-line summary from SKILL.md frontmatter `description:`. */
  description?: string;
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

/** Same shape as parseRoles — selected_skills is a JSON-encoded string[] or null. */
function parseSelectedSkills(raw: unknown): string[] | null {
  return parseRoles(raw);
}

export function listSubscriptions(
  projectId: string,
): ProjectSubscriptionRow[] {
  const db = getDb();
  const stmt = db.prepare(
    `SELECT project_id, source_id, bundle_id, subscribed_at, installed_version, roles, selected_skills
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
      selectedSkills: parseSelectedSkills(row[6]),
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
 * Set which skills inside a bundle the subscription should load.
 * Pass `null` for "all skills in the bundle" (default at subscribe
 * time, same as pre-v18 behaviour). An empty array means "none" —
 * the bundle is subscribed but no skills make it through to claude,
 * useful only as a transient state while the user picks via the UI.
 */
export function setSubscriptionSkills(
  projectId: string,
  sourceId: string,
  bundleId: string,
  skills: string[] | null,
): void {
  const db = getDb();
  const value = skills ? JSON.stringify(skills) : null;
  const stmt = db.prepare(
    `UPDATE project_subscribed_bundles
     SET selected_skills = ?
     WHERE project_id = ? AND source_id = ? AND bundle_id = ?`,
  );
  stmt.run([value, projectId, sourceId, bundleId]);
  stmt.free();
  scheduleSave();
}

/**
 * Walk a bundle's cache directory and enumerate every subdirectory
 * that contains a SKILL.md file — those are the bundle's "skills" in
 * Claude Code's plugin model. Returns alphabetical order so the UI
 * checkbox list is stable across sessions.
 *
 * Reads YAML-style frontmatter (`---\nkey: value\n---`) from each
 * SKILL.md to populate the `name` + `description` fields the picker
 * UI shows. Missing frontmatter is fine — the skill still lists, just
 * without a friendly label.
 */
export function listBundleSkills(
  sourceId: string,
  bundleId: string,
): BundleSkillInfo[] {
  const bundle = findBundle(sourceId, bundleId);
  if (!bundle) return [];
  const bundleDir = bundlePluginDir(sourceId, bundle);
  if (!fs.existsSync(bundleDir)) return [];
  const entries = fs.readdirSync(bundleDir, { withFileTypes: true });
  const out: BundleSkillInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip the plugin metadata dir + any hidden dirs.
    if (entry.name.startsWith('.')) continue;
    const skillFile = path.join(bundleDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    let head: { name?: string; description?: string } = {};
    try {
      const raw = fs.readFileSync(skillFile, 'utf8');
      head = parseSkillFrontmatter(raw);
    } catch {
      // Skill still gets listed — just unlabeled.
    }
    out.push({ id: entry.name, ...head });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Minimal YAML frontmatter parser: pulls `name:` and `description:`
 * out of the leading `---` block of a SKILL.md. Not a real YAML
 * parser — handles flat string fields only. Anything more exotic
 * (multi-line strings, nested objects) is ignored, which is fine
 * because the picker only needs id + name + description.
 */
function parseSkillFrontmatter(raw: string): {
  name?: string;
  description?: string;
} {
  if (!raw.startsWith('---')) return {};
  const endIdx = raw.indexOf('\n---', 3);
  if (endIdx < 0) return {};
  const block = raw.slice(3, endIdx).trim();
  const out: { name?: string; description?: string } = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^(\w+)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let value = m[2];
    // Strip simple surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === 'name') out.name = value;
    else if (key === 'description') out.description = value;
  }
  return out;
}

/**
 * Build a synthetic plugin directory containing the bundle's
 * `.claude-plugin/` plus only the chosen skill subdirs. Returns the
 * absolute path to the synthetic dir, ready to pass as --plugin-dir.
 *
 * Rebuilt from scratch each time it's called (cheap — SKILL.md files
 * are small and we only copy a handful). That's deliberate: caching
 * adds an invalidation problem (the bundle dir can change after a
 * sync brings in new skill content), and the throughput cost is in
 * the millisecond range vs the seconds claude takes to spin up.
 */
function materializeSubset(
  scope: string,
  sourceId: string,
  bundleId: string,
  skills: string[],
): string {
  const bundle = findBundle(sourceId, bundleId);
  if (!bundle) {
    throw new Error(`bundle not found: ${sourceId}/${bundleId}`);
  }
  const bundleDir = bundlePluginDir(sourceId, bundle);
  const subsetRoot = path.join(
    app.getPath('userData'),
    'skill-marketplaces',
    '.subsets',
  );
  const subsetDir = path.join(
    subsetRoot,
    `${sanitizeId(scope)}--${sanitizeId(sourceId)}--${sanitizeId(bundleId)}`,
  );
  if (fs.existsSync(subsetDir)) {
    fs.rmSync(subsetDir, { recursive: true, force: true });
  }
  fs.mkdirSync(subsetDir, { recursive: true });

  // Copy .claude-plugin/ so the plugin's metadata + commands ride
  // along. Anything inside skills/ that we didn't pick is naturally
  // absent. Use cpSync which is recursive + cross-platform.
  const metaSrc = path.join(bundleDir, '.claude-plugin');
  const metaDest = path.join(subsetDir, '.claude-plugin');
  if (fs.existsSync(metaSrc)) {
    fs.cpSync(metaSrc, metaDest, { recursive: true });
  }
  // Copy each chosen skill subdir, ignoring ones that don't exist
  // (e.g. user picked them when an older sync had the file but the
  // upstream removed it).
  for (const skillId of skills) {
    const skillSrc = path.join(bundleDir, skillId);
    if (!fs.existsSync(skillSrc)) continue;
    const skillDest = path.join(subsetDir, skillId);
    fs.cpSync(skillSrc, skillDest, { recursive: true });
  }
  return subsetDir;
}

/**
 * Resolve a subscription to its on-disk --plugin-dir argument.
 * Subscriptions with no selectedSkills return the bundle's original
 * cache path (cheapest); subscriptions with a selection materialize a
 * synthetic subset dir. Used by the runner so each spawn site doesn't
 * need to know about the subset machinery.
 */
function pluginDirForSubscription(
  sub: ProjectSubscriptionRow,
): string | null {
  const bundle = findBundle(sub.sourceId, sub.bundleId);
  if (!bundle) return null;
  if (!sub.selectedSkills || sub.selectedSkills.length === 0) {
    // null = all skills (load the whole bundle). Empty array would
    // mean "no skills" which renders the subscription a no-op; skip
    // entirely so we don't pass a --plugin-dir for an empty subset.
    if (sub.selectedSkills && sub.selectedSkills.length === 0) return null;
    const dir = bundlePluginDir(sub.sourceId, bundle);
    return fs.existsSync(dir) ? dir : null;
  }
  try {
    return materializeSubset(
      sub.projectId,
      sub.sourceId,
      sub.bundleId,
      sub.selectedSkills,
    );
  } catch (e) {
    console.error(
      `[marketplace] materializeSubset failed for ${sub.sourceId}/${sub.bundleId}:`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
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
  // Union global-scoped subs with the project's own subs. Project
  // subs come FIRST so on a (sourceId, bundleId) collision the
  // project's roles + selectedSkills win over the global default.
  // Matches the standard "project overrides global" mental model
  // (CSS, config, npm scopes); also needed for the "fork to project
  // for customization" and "copy globals to new project" flows.
  const subs = [
    ...listSubscriptions(projectId),
    ...listSubscriptions(MARKETPLACE_GLOBAL_SCOPE_ID),
  ];
  if (subs.length === 0) return [];
  // Pre-compute the enabled-source set so we don't re-query per
  // iteration. Disabled sources keep their subscriptions in the DB
  // but don't contribute to any spawn's --plugin-dir.
  const enabledSourceIds = new Set(
    listSources()
      .filter((s) => s.enabled)
      .map((s) => s.id),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of subs) {
    if (!enabledSourceIds.has(s.sourceId)) continue;
    const key = `${s.sourceId}\x00${s.bundleId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (s.roles !== null && !s.roles.includes(role)) continue;
    // pluginDirForSubscription handles the all-skills vs subset
    // routing — returns either the original bundle dir or a
    // freshly-materialized synthetic subset dir.
    const dir = pluginDirForSubscription(s);
    if (dir) out.push(dir);
  }
  return out;
}

/**
 * Move a subscription between scopes (project ↔ global). Preserves
 * installed_version + roles so the user doesn't have to redo the per-
 * role chip config after a move. Returns true if anything moved; false
 * if no subscription existed at `from` (already at `to`, or never
 * installed).
 */
export function moveSubscription(
  sourceId: string,
  bundleId: string,
  fromProjectId: string,
  toProjectId: string,
): boolean {
  if (fromProjectId === toProjectId) return false;
  const db = getDb();
  // Read the source row first so we can re-insert the same state at the
  // destination. UPDATE project_id = ? would also work, but doing a
  // delete + insert pair keeps the failure mode simpler if the dest
  // already has a row (PK conflict on UPDATE is silent in sql.js).
  const sel = db.prepare(
    `SELECT subscribed_at, installed_version, roles, selected_skills
     FROM project_subscribed_bundles
     WHERE project_id = ? AND source_id = ? AND bundle_id = ?`,
  );
  sel.bind([fromProjectId, sourceId, bundleId]);
  let subscribedAt: number | null = null;
  let installedVersion: string | null = null;
  let roles: string | null = null;
  let selectedSkills: string | null = null;
  if (sel.step()) {
    const row = sel.get();
    subscribedAt = asIntOrNull(row[0]);
    installedVersion = asStrOrNull(row[1]);
    roles = asStrOrNull(row[2]);
    selectedSkills = asStrOrNull(row[3]);
  }
  sel.free();
  if (subscribedAt === null) return false;

  const del = db.prepare(
    `DELETE FROM project_subscribed_bundles
     WHERE project_id = ? AND source_id = ? AND bundle_id = ?`,
  );
  del.run([fromProjectId, sourceId, bundleId]);
  del.free();

  const ins = db.prepare(
    `INSERT OR REPLACE INTO project_subscribed_bundles
       (project_id, source_id, bundle_id, subscribed_at, installed_version, roles, selected_skills)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  ins.run([
    toProjectId,
    sourceId,
    bundleId,
    subscribedAt,
    installedVersion,
    roles,
    selectedSkills,
  ]);
  ins.free();
  scheduleSave();
  return true;
}
