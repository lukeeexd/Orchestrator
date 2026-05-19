import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
 * Walk every entry inside `root` and throw if any of them resolves
 * (via realpath) to a path outside `root`. Defense-in-depth against
 * a tar that didn't strip `..` entries: a malicious marketplace
 * source could otherwise plant files at known absolute paths during
 * the extract step. The post-extract walk is cheap (tens of files)
 * and bails on the first escape.
 */
function assertNoPathTraversal(root: string): void {
  const rootReal = fs.realpathSync(root);
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      // realpath the child (resolves symlinks). If realpath itself
      // fails (broken symlink / dangling junction), refuse — we
      // can't prove it's contained.
      let childReal: string;
      try {
        childReal = fs.realpathSync(child);
      } catch {
        throw new Error(
          `tarball contains an unresolvable entry: ${entry.name}`,
        );
      }
      if (
        !(
          childReal === rootReal ||
          childReal.startsWith(rootReal + path.sep)
        )
      ) {
        throw new Error(
          `tarball escapes extract root: ${child} -> ${childReal}`,
        );
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        stack.push(child);
      }
    }
  }
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
  // L2: pre-allocate both temp paths and put the entire write +
  // extract flow under one try/finally so a throw mid-pipeline (or
  // mid-mkdir) doesn't orphan the partially-written tarball.
  const tempTar = path.join(
    os.tmpdir(),
    `orchestrator-marketplace-${randomUUID()}.tar.gz`,
  );
  const tempExtract = path.join(
    os.tmpdir(),
    `orchestrator-marketplace-${randomUUID()}-extract`,
  );
  try {
    await pipeline(
      Readable.fromWeb(tarResp.body as never),
      fs.createWriteStream(tempTar),
    );

    // 3. Extract to a sibling temp dir, then atomic-replace the cache
    //    dir. We use a temp dir + rename instead of extracting into the
    //    final location so a partial extract from a network failure
    //    doesn't leave a corrupted cache.
    fs.mkdirSync(tempExtract, { recursive: true });

    await runTar(['-xzf', tempTar, '-C', tempExtract], {
      timeoutMs: 5 * 60 * 1000,
    });

    // M5: defense-in-depth path traversal guard. Microsoft's bsdtar
    // on Win10+ already rejects `..` entries, but a GNU tar in the
    // user's PATH (msys/WSL passthrough) would follow them. Walk
    // the extracted tree and refuse any file whose normalized path
    // escapes tempExtract. If any escape is found we treat the
    // whole extract as poisoned and bail before the rename.
    assertNoPathTraversal(tempExtract);

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

/**
 * Skill-level enablement for a subscription. Three shapes:
 *
 * - `null` — load every skill in the bundle for every enabled role.
 *   Default at subscribe time; cheapest path at the runner.
 * - `string[]` (flat) — load these specific skills for every enabled
 *   role. Pre-v19 form; preserved so existing rows / the legacy "Pick"
 *   modal still work without migration.
 * - `Record<role, string[]>` (per-role) — each enabled role gets its
 *   own skill list. Lets a single bundle subscription wire different
 *   skills to coder vs qa vs director, etc. Missing role keys mean
 *   "no skills from this bundle for that role" — explicit empty array
 *   has the same effect.
 */
export type SelectedSkills =
  | null
  | string[]
  | Record<string, string[]>;

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
  selectedSkills: SelectedSkills;
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

/**
 * Parse the JSON-encoded selected_skills column. Accepts the legacy
 * `string[]` form (skills apply to every enabled role) and the per-role
 * `Record<role, string[]>` form (each role gets its own list). Returns
 * `null` on malformed / empty input so the runner falls back to
 * "all skills".
 */
function parseSelectedSkills(raw: unknown): SelectedSkills {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item === 'string' && item.length > 0) out.push(item);
    }
    return out;
  }
  if (parsed && typeof parsed === 'object') {
    const map: Record<string, string[]> = {};
    for (const [role, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const list: string[] = [];
      for (const item of value) {
        if (typeof item === 'string' && item.length > 0) list.push(item);
      }
      map[role] = list;
    }
    return map;
  }
  return null;
}

/**
 * Resolve a subscription's effective skill list for a specific role.
 *
 * - `null` means "every skill in the bundle" (caller skips the subset
 *   step and passes the bundle dir directly to --plugin-dir).
 * - `[]` means "no skills from this bundle for this role" (caller skips
 *   the --plugin-dir entirely).
 * - A non-empty array means "materialize a subset with exactly these
 *   skills" — caller copies them into a synthetic plugin dir.
 *
 * Backwards-compat: a legacy `string[]` selectedSkills column applies
 * its list to every role uniformly, matching pre-v19 behaviour.
 */
function skillsForRole(
  sub: ProjectSubscriptionRow,
  role: string,
): string[] | null {
  if (sub.selectedSkills === null) return null;
  if (Array.isArray(sub.selectedSkills)) {
    // Legacy flat form: same skills for every enabled role.
    return sub.selectedSkills;
  }
  // Per-role map: a missing key is equivalent to an explicit empty
  // array. Both mean "this role doesn't load anything from this
  // bundle".
  return sub.selectedSkills[role] ?? [];
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
 *
 * Three forms accepted, mirroring the column shape:
 * - `null` — load every skill for every role (cheapest path).
 * - `string[]` — load these specific skills for every enabled role
 *   (legacy flat form; kept for the Pick modal and older callers).
 * - `Record<role, string[]>` — per-role skill picks. Roles missing
 *   from the map get no skills from this bundle.
 *
 * An empty array (`[]`) in either form means "no skills" — useful as
 * a transient state while the user picks; the runner skips passing
 * --plugin-dir for that role entirely.
 */
export function setSubscriptionSkills(
  projectId: string,
  sourceId: string,
  bundleId: string,
  skills: SelectedSkills,
): void {
  const db = getDb();
  const value = skills === null ? null : JSON.stringify(skills);
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
  // Claude Code's canonical plugin layout puts skills under
  // `<bundle>/skills/<name>/SKILL.md`. Some older bundles drop them
  // at the bundle root (`<bundle>/<name>/SKILL.md`) — fall back to
  // that if no `skills/` directory exists.
  const skillsSubdir = path.join(bundleDir, 'skills');
  const walkRoot = fs.existsSync(skillsSubdir) ? skillsSubdir : bundleDir;
  const entries = fs.readdirSync(walkRoot, { withFileTypes: true });
  const out: BundleSkillInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip the plugin metadata dir + any hidden dirs.
    if (entry.name.startsWith('.')) continue;
    const skillFile = path.join(walkRoot, entry.name, 'SKILL.md');
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
 * Read the full text of a skill's SKILL.md, by `(sourceId, bundleId,
 * skillId)`. Honours the same canonical-vs-legacy layout split as
 * listBundleSkills — `<bundle>/skills/<id>/SKILL.md` first, falling
 * back to `<bundle>/<id>/SKILL.md` for older marketplaces.
 *
 * Returns `null` when the bundle, the skill subdir, or the SKILL.md
 * file is missing on disk. Callers (the preview modal) show a "not
 * synced yet?" hint in that case.
 */
export function readSkillContent(
  sourceId: string,
  bundleId: string,
  skillId: string,
): string | null {
  const bundle = findBundle(sourceId, bundleId);
  if (!bundle) return null;
  const bundleDir = bundlePluginDir(sourceId, bundle);
  if (!fs.existsSync(bundleDir)) return null;
  const candidates = [
    path.join(bundleDir, 'skills', skillId, 'SKILL.md'),
    path.join(bundleDir, skillId, 'SKILL.md'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    } catch {
      // try the next layout
    }
  }
  return null;
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
 * Cache of materialized subset dirs keyed by their stable
 * `(scope, role, sourceId, bundleId)` location. Value tracks the
 * inputs that produced the on-disk subset so we can skip the
 * rm+rebuild when nothing has changed.
 *
 * Invalidation token = `(bundle-dir mtime, sorted-skills hash)`.
 * A `syncSource` re-clone of the source bumps the bundle dir's
 * mtime; the user toggling skills changes the hash. Either trips
 * the cache miss and we rebuild.
 *
 * The cache also serves as a per-key mutex: two parallel
 * `materializeSubset` calls that would otherwise race the same
 * rm+cpSync against each other see a cache hit on the second call
 * (because the first call's writes are visible synchronously) and
 * skip the rebuild entirely.
 */
interface SubsetCacheEntry {
  bundleMtimeMs: number;
  skillsHash: string;
}
const subsetCache = new Map<string, SubsetCacheEntry>();

function hashSkills(skills: readonly string[]): string {
  const sorted = [...skills].sort();
  return createHash('sha1').update(sorted.join('\x00')).digest('hex');
}

/**
 * Build a synthetic plugin directory containing the bundle's
 * `.claude-plugin/` plus only the chosen skill subdirs. Returns the
 * absolute path to the synthetic dir, ready to pass as --plugin-dir.
 *
 * Cached on `(bundle mtime, sorted skills)` — two parallel spawns
 * of the same (scope, role, source, bundle) won't race a rebuild
 * against each other, and an unchanged repeat call returns
 * instantly. A `syncSource` re-clone bumps the bundle mtime which
 * is what trips the cache and forces a fresh subset.
 */
function materializeSubset(
  scope: string,
  role: string,
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
  // Role goes in the dir name so per-role subset selections don't
  // clobber each other — coder + qa each get a separate plugin dir
  // with their own SKILL.md set.
  const subsetDir = path.join(
    subsetRoot,
    `${sanitizeId(scope)}--${sanitizeId(role)}--${sanitizeId(sourceId)}--${sanitizeId(bundleId)}`,
  );

  // Cache check. statSync throws on missing source bundle dir —
  // let it propagate, the bundle isn't materializable.
  const bundleStat = fs.statSync(bundleDir);
  const bundleMtimeMs = bundleStat.mtimeMs;
  const skillsHash = hashSkills(skills);
  const cacheKey = subsetDir;
  const cached = subsetCache.get(cacheKey);
  if (
    cached &&
    cached.bundleMtimeMs === bundleMtimeMs &&
    cached.skillsHash === skillsHash &&
    fs.existsSync(subsetDir)
  ) {
    return subsetDir;
  }

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
  // Mirror the source layout: skills live under `<bundle>/skills/`
  // in the canonical Claude Code plugin spec; the legacy fallback is
  // `<bundle>/<skill>` at the root. Match whichever the source uses
  // so Claude's auto-loader still finds them in the subset.
  const skillsSubdir = path.join(bundleDir, 'skills');
  const sourceLayoutIsNested = fs.existsSync(skillsSubdir);
  const srcRoot = sourceLayoutIsNested ? skillsSubdir : bundleDir;
  const destRoot = sourceLayoutIsNested
    ? path.join(subsetDir, 'skills')
    : subsetDir;
  if (sourceLayoutIsNested) fs.mkdirSync(destRoot, { recursive: true });
  // Copy each chosen skill subdir, ignoring ones that don't exist
  // (e.g. user picked them when an older sync had the file but the
  // upstream removed it).
  for (const skillId of skills) {
    const skillSrc = path.join(srcRoot, skillId);
    if (!fs.existsSync(skillSrc)) continue;
    const skillDest = path.join(destRoot, skillId);
    fs.cpSync(skillSrc, skillDest, { recursive: true });
  }
  subsetCache.set(cacheKey, { bundleMtimeMs, skillsHash });
  return subsetDir;
}

/**
 * Computes "which skills will each agent role have access to" for a
 * given project. Used by the Director: each turn ships with a
 * `[project skills]` block built from this, so the Director can name
 * specific skills in plan task lines instead of guessing.
 *
 * Mirrors pluginDirsForProject's resolution rules:
 * - Subscriptions at the project scope + at the global sentinel.
 * - Project subs win on (sourceId, bundleId) collisions.
 * - Disabled sources are skipped.
 * - Per-role chips filter which roles see each bundle.
 * - selectedSkills narrows to a subset when set; null = all skills.
 *
 * 'director' is treated as a pseudo-role alongside the AgentRole keys
 * since Director spawns also load plugin-dirs.
 */
export function availableSkillsByRole(
  projectId: string,
): Record<string, BundleSkillInfo[]> {
  const allRoles = [
    'pm',
    'researcher',
    'coder',
    'qa',
    'devops',
    'security',
    'director',
  ];
  const projectSubs = listSubscriptions(projectId);
  const globalSubs = listSubscriptions(MARKETPLACE_GLOBAL_SCOPE_ID);
  // Project first so it wins the (source, bundle) dedupe — matches
  // the runner's pluginDirsForProject order.
  const seen = new Set<string>();
  const deduped: ProjectSubscriptionRow[] = [];
  for (const s of [...projectSubs, ...globalSubs]) {
    const key = `${s.sourceId}\x00${s.bundleId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(s);
  }
  const enabledSourceIds = new Set(
    listSources()
      .filter((s) => s.enabled)
      .map((s) => s.id),
  );

  // Pre-cache bundle skill lists since multiple roles may share a
  // bundle — listBundleSkills walks the dir + parses frontmatter and
  // we don't want to repeat that work per role per bundle.
  const bundleCache = new Map<string, BundleSkillInfo[]>();
  const skillsFor = (
    sub: ProjectSubscriptionRow,
    role: string,
  ): BundleSkillInfo[] => {
    const key = `${sub.sourceId}\x00${sub.bundleId}`;
    let all = bundleCache.get(key);
    if (!all) {
      all = listBundleSkills(sub.sourceId, sub.bundleId);
      bundleCache.set(key, all);
    }
    const selected = skillsForRole(sub, role);
    if (selected === null) return all;
    if (selected.length === 0) return [];
    const wanted = new Set(selected);
    return all.filter((s) => wanted.has(s.id));
  };

  const out: Record<string, BundleSkillInfo[]> = {};
  for (const role of allRoles) {
    const skills: BundleSkillInfo[] = [];
    for (const sub of deduped) {
      if (!enabledSourceIds.has(sub.sourceId)) continue;
      if (sub.roles !== null && !sub.roles.includes(role)) continue;
      skills.push(...skillsFor(sub, role));
    }
    // Dedupe by skill id in case multiple bundles ship the same name
    // (rare but defensive). Keep first occurrence.
    const dedupedSkills: BundleSkillInfo[] = [];
    const skillSeen = new Set<string>();
    for (const s of skills) {
      if (skillSeen.has(s.id)) continue;
      skillSeen.add(s.id);
      dedupedSkills.push(s);
    }
    out[role] = dedupedSkills;
  }
  return out;
}

/**
 * Resolve a subscription to its on-disk --plugin-dir argument for a
 * specific role. Per-role resolution because the same subscription may
 * surface different skills to coder vs qa vs director (when the
 * subscription uses the per-role map form of selectedSkills).
 *
 * Returns:
 * - the bundle's full cache path when this role takes all skills
 *   (cheapest — no materialization).
 * - a synthetic subset dir when this role takes a curated list.
 * - null when the bundle/role contributes no skills (skip the
 *   --plugin-dir entirely).
 */
function pluginDirForSubscription(
  sub: ProjectSubscriptionRow,
  role: string,
): string | null {
  const bundle = findBundle(sub.sourceId, sub.bundleId);
  if (!bundle) return null;
  const selected = skillsForRole(sub, role);
  if (selected === null) {
    // All skills — pass the bundle dir straight through.
    const dir = bundlePluginDir(sub.sourceId, bundle);
    return fs.existsSync(dir) ? dir : null;
  }
  if (selected.length === 0) return null;
  try {
    return materializeSubset(
      sub.projectId,
      role,
      sub.sourceId,
      sub.bundleId,
      selected,
    );
  } catch (e) {
    console.error(
      `[marketplace] materializeSubset failed for ${sub.sourceId}/${sub.bundleId} role=${role}:`,
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
    // freshly-materialized synthetic subset dir for this specific
    // role.
    const dir = pluginDirForSubscription(s, role);
    if (dir) out.push(dir);
  }
  return out;
}

/**
 * One bundle's contribution to a role's spawn-time loadout, as
 * reported by `resolveLoadout`. Used by the dry-run UI to show the
 * user "this is exactly what a fresh <role> spawn would receive,
 * without actually spawning anything".
 */
export interface LoadoutEntry {
  sourceId: string;
  bundleId: string;
  /** Where the subscription lives — 'project' wins over 'global' on (source, bundle) collisions. */
  scope: 'global' | 'project';
  /** The resolved --plugin-dir path. `null` when the bundle isn't on disk or otherwise failed to materialize. */
  pluginDir: string | null;
  /** Skills this role will actually see from this bundle. */
  skills: BundleSkillInfo[];
  /** When set, the runtime path is broken in some recoverable way (e.g. source not synced, skill removed upstream). */
  warning?: string;
}

export interface LoadoutReport {
  role: string;
  entries: LoadoutEntry[];
  /** Sum of skill counts across all entries — what the agent sees as "available skills". */
  totalSkills: number;
  /**
   * Rough estimate of the bytes added to the agent's system prompt by
   * exposing these skill descriptions (frontmatter only — the actual
   * SKILL.md body only loads on-demand when a skill triggers). Used by
   * the UI as a context-budget heads-up.
   */
  approxFrontmatterChars: number;
}

/**
 * Compute the loadout a fresh agent of `role` would receive in
 * `projectId` right now, without spawning anything. Mirrors
 * `pluginDirsForProject`'s resolution rules (subscription dedupe,
 * enabled-source filter, role chips, per-role skill picks,
 * materialization) but returns rich data the UI can render as a
 * dry-run report.
 */
export function resolveLoadout(
  projectId: string,
  role: string,
): LoadoutReport {
  const subs = [
    ...listSubscriptions(projectId),
    ...listSubscriptions(MARKETPLACE_GLOBAL_SCOPE_ID),
  ];
  const enabledSourceIds = new Set(
    listSources()
      .filter((s) => s.enabled)
      .map((s) => s.id),
  );
  const entries: LoadoutEntry[] = [];
  const seen = new Set<string>();
  for (const s of subs) {
    if (!enabledSourceIds.has(s.sourceId)) continue;
    const key = `${s.sourceId}\x00${s.bundleId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (s.roles !== null && !s.roles.includes(role)) continue;

    const bundleAllSkills = listBundleSkills(s.sourceId, s.bundleId);
    const selected = skillsForRole(s, role);

    let effectiveSkills: BundleSkillInfo[];
    if (selected === null) {
      effectiveSkills = bundleAllSkills;
    } else if (selected.length === 0) {
      // Per-role map explicitly excludes this role — skip the entry
      // rather than report an empty bundle. Matches what the runner
      // does (no --plugin-dir at all for this combo).
      continue;
    } else {
      const wanted = new Set(selected);
      effectiveSkills = bundleAllSkills.filter((sk) => wanted.has(sk.id));
    }

    const pluginDir = pluginDirForSubscription(s, role);
    let warning: string | undefined;
    if (!pluginDir) {
      warning =
        'Bundle directory not found on disk — source may not be synced, or upstream removed it.';
    } else if (effectiveSkills.length < (selected?.length ?? 0)) {
      // Some picked skills couldn't be found on disk (renamed /
      // removed upstream since the user selected them).
      const missing = (selected ?? []).filter(
        (id) => !effectiveSkills.find((sk) => sk.id === id),
      );
      warning =
        missing.length === 1
          ? `Picked skill "${missing[0]}" is missing on disk.`
          : `${missing.length} picked skills are missing on disk (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}).`;
    }

    entries.push({
      sourceId: s.sourceId,
      bundleId: s.bundleId,
      scope:
        s.projectId === MARKETPLACE_GLOBAL_SCOPE_ID ? 'global' : 'project',
      pluginDir,
      skills: effectiveSkills,
      warning,
    });
  }

  const totalSkills = entries.reduce((n, e) => n + e.skills.length, 0);
  // ~20 chars per skill for "- <name>: " framing + 0..160 chars per
  // description (descriptions are usually short, capped by SKILL.md
  // convention). Rough but useful — the user wants order-of-magnitude.
  const approxFrontmatterChars = entries.reduce(
    (n, e) =>
      n +
      e.skills.reduce(
        (m, sk) =>
          m + 20 + (sk.name?.length ?? 0) + (sk.description?.length ?? 0),
        0,
      ),
    0,
  );

  return { role, entries, totalSkills, approxFrontmatterChars };
}

// ─────────────────────────── Skill fire telemetry ───────────────────────────

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
