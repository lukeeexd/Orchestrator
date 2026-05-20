import { MARKETPLACE_GLOBAL_SCOPE_ID } from '../../shared/ipc';
import { listSources } from './sources';
import {
  type BundleSkillInfo,
  type ProjectSubscriptionRow,
  listBundleSkills,
  listSubscriptions,
  pluginDirForSubscription,
  skillsForRole,
} from './subscriptions';

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
  const subs: ProjectSubscriptionRow[] = [
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
