import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { getDb, scheduleSave } from '../db';
import { MARKETPLACE_GLOBAL_SCOPE_ID } from '../../shared/ipc';
import {
  asInt,
  asIntOrNull,
  asStr,
  asStrOrNull,
  sanitizeId,
} from './internal';
import {
  bundlePluginDir,
  findBundle,
  listSources,
} from './sources';

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
 *
 * Exported so the loadout module can mirror the runner's per-role
 * resolution without duplicating the logic.
 */
export function skillsForRole(
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
 * R-Vuln5-2026-05-28: `name` and `description` come from third-party
 * marketplace SKILL.md frontmatter and flow into the Director's
 * `[project skills]` block on every turn (runner.ts buildSkillsBlock).
 * The Director system prompt instructs naming skills in plan task lines,
 * so a bundle author can stuff prompt-injection directives into the
 * metadata and steer worker tasks — with `bypassPermissions` on the
 * worker. Pre-fix `name` had no length cap at all, defeating the
 * description's 80-char truncation. We cap both fields and strip
 * characters that don't belong in legitimate skill metadata:
 *   - backticks (markdown-code framing the LLM imitates),
 *   - angle brackets / square brackets / braces (tag-like markers
 *     that look like instructions),
 *   - pipes / semicolons / ampersands (shell-flavoured punctuation
 *     that primes the LLM toward "run this"),
 *   - backslashes (the main vector for smuggling YAML escapes past
 *     the line-bounded parser).
 * Newlines can't survive `block.split(/\r?\n/)` anyway, so the residual
 * surface is plain-text directive language — which we further blunt
 * by capping length so even if a directive slips through it can't carry
 * a full instruction payload.
 *
 * Independent of this, marketplace bundles remain a trust delegation:
 * subscribing to a skill grants its SKILL.md body access to the
 * worker prompt via `--plugin-dir`. The fix here is specifically the
 * "metadata UI shows one thing, Director sees another" mismatch.
 */
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 200;

export function sanitizeSkillMetaValue(value: string, max: number): string {
  // Strip characters that don't appear in legitimate skill metadata
  // (see comment block above for rationale).
  const stripped = value.replace(/[`<>[\]{}|;&\\]/g, '');
  // Collapse runs of whitespace, trim, then cap length.
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? collapsed.slice(0, max) : collapsed;
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
    if (key === 'name') {
      out.name = sanitizeSkillMetaValue(value, SKILL_NAME_MAX);
    } else if (key === 'description') {
      out.description = sanitizeSkillMetaValue(value, SKILL_DESCRIPTION_MAX);
    }
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
 *
 * Exported so loadout.ts can reuse the same materialization path the
 * runner uses, ensuring the dry-run preview matches actual spawns.
 */
export function pluginDirForSubscription(
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
