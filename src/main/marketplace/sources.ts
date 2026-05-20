import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { app } from 'electron';
import { getDb, scheduleSave } from '../db';
import {
  asInt,
  asIntOrNull,
  asStr,
  asStrOrNull,
  sanitizeId,
} from './internal';

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
