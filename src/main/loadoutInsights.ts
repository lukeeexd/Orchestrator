import type { LoadoutInsight } from '../shared/types';
import { MARKETPLACE_GLOBAL_SCOPE_ID } from '../shared/ipc';
import { listProjects } from './projects';
import * as marketplace from './marketplace';

/**
 * Self-improving-loadout nudges surfaced on the Marketplace screen.
 *
 * v1 ships one rule:
 *
 *   prune-idle-skills — a bundle subscription with `selectedSkills=null`
 *   (the default "all skills" form) where the bundle has ≥5 skills, has
 *   been subscribed for ≥7 days, and where a notable fraction of the
 *   bundle's skills have never fired anywhere. The card offers to narrow
 *   the subscription's selectedSkills to only the firing ones — a one-
 *   click prune that keeps the agent's available-skill list tight
 *   without losing anything the user actually uses.
 *
 * Why this rule first: it's the highest-signal, lowest-risk nudge over
 * the data we already collect. The user can always re-broaden by
 * clearing the selection — the action is reversible.
 *
 * Out of scope for v1: hot-skill promotion (needs a default-loadout
 * concept we don't have), loadout-drift reset against the Recommended
 * setup (needs a snapshot of what they once accepted), and per-role
 * narrowing when selectedSkills is already a per-role map (more complex
 * diff resolution).
 */

const MIN_SUBSCRIPTION_AGE_MS = 7 * 24 * 3600 * 1000;
const MIN_BUNDLE_SKILL_COUNT = 5;
/** Trigger the insight when this fraction of skills have never fired. */
const IDLE_THRESHOLD = 0.3;

/**
 * Compute insights for the given project scope. The renderer typically
 * passes the active projectId; insights cover that scope's subscriptions
 * plus the global ones (project overrides global on collisions, same
 * resolution rule as pluginDirsForProject).
 */
export function getLoadoutInsights(projectId: string): LoadoutInsight[] {
  const insights: LoadoutInsight[] = [];
  const now = Date.now();

  // Walk subscriptions: project + global, dedup on (source, bundle)
  // with project winning. Mirrors the runner's resolution shape so the
  // pruned selection lands on the same row the runner actually loads.
  type WalkedSub = {
    sourceId: string;
    bundleId: string;
    subscribedAt: number;
    selectedSkills: marketplace.SelectedSkills;
    scope: string; // projectId or MARKETPLACE_GLOBAL_SCOPE_ID
  };
  const seen = new Set<string>();
  const subs: WalkedSub[] = [];
  for (const s of marketplace.listSubscriptions(projectId)) {
    const key = `${s.sourceId}\x00${s.bundleId}`;
    seen.add(key);
    subs.push({
      sourceId: s.sourceId,
      bundleId: s.bundleId,
      subscribedAt: s.subscribedAt,
      selectedSkills: s.selectedSkills,
      scope: projectId,
    });
  }
  for (const s of marketplace.listSubscriptions(MARKETPLACE_GLOBAL_SCOPE_ID)) {
    const key = `${s.sourceId}\x00${s.bundleId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    subs.push({
      sourceId: s.sourceId,
      bundleId: s.bundleId,
      subscribedAt: s.subscribedAt,
      selectedSkills: s.selectedSkills,
      scope: MARKETPLACE_GLOBAL_SCOPE_ID,
    });
  }

  // Cross-project fire data: a skill has "ever fired" if any project's
  // skill_fire_counts table has a non-zero row for (source, bundle,
  // skill). The role dimension doesn't matter for the pruning decision
  // — if a skill fires for ANY role, we keep it (narrowing per-role is
  // a finer follow-up).
  const firedSkills = new Set<string>();
  const allProjectIds = [
    MARKETPLACE_GLOBAL_SCOPE_ID,
    ...listProjects().map((p) => p.id),
  ];
  for (const pid of allProjectIds) {
    for (const fc of marketplace.getSkillFireCounts(pid)) {
      if (fc.count > 0) {
        firedSkills.add(
          `${fc.sourceId}\x00${fc.bundleId}\x00${fc.skillId}`,
        );
      }
    }
  }

  for (const sub of subs) {
    // The rule applies only when selectedSkills is null (the "all skills"
    // default). When the user has already curated a per-role or flat
    // list, treat that as deliberate and don't second-guess it.
    if (sub.selectedSkills !== null) continue;
    if (now - sub.subscribedAt < MIN_SUBSCRIPTION_AGE_MS) continue;

    const skills = marketplace.listBundleSkills(sub.sourceId, sub.bundleId);
    if (skills.length < MIN_BUNDLE_SKILL_COUNT) continue;

    const kept: string[] = [];
    const pruned: string[] = [];
    for (const sk of skills) {
      const key = `${sub.sourceId}\x00${sub.bundleId}\x00${sk.id}`;
      if (firedSkills.has(key)) {
        kept.push(sk.id);
      } else {
        pruned.push(sk.id);
      }
    }

    const idleFraction = pruned.length / skills.length;
    if (idleFraction < IDLE_THRESHOLD) continue;
    // Need at least one firing skill to keep — pruning everything would
    // just be "unsubscribe", which is P3's idle-subscription rule.
    if (kept.length === 0) continue;

    const scopeLabel =
      sub.scope === MARKETPLACE_GLOBAL_SCOPE_ID ? 'global' : 'this project';
    insights.push({
      id: `prune-idle-${sub.sourceId}-${sub.bundleId}-${sub.scope}`,
      severity: 'info',
      title: `${sub.bundleId}: ${pruned.length} of ${skills.length} skills have never fired`,
      body:
        `The ${scopeLabel} subscription to ${sub.sourceId}/${sub.bundleId} ` +
        `loads every skill in the bundle by default. ${pruned.length} of the ` +
        `${skills.length} have never fired in any run. Narrowing to the ` +
        `${kept.length} that do fire keeps the agents' available-skill list ` +
        `tight without losing anything you actually use.`,
      action: {
        kind: 'prune-idle-skills',
        sourceId: sub.sourceId,
        bundleId: sub.bundleId,
        scope: sub.scope,
        keepSkillIds: kept,
        pruneSkillIds: pruned,
      },
    });
  }

  return insights;
}
