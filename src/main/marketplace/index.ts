/**
 * Marketplace module — public barrel.
 *
 * Re-exports the marketplace layer's public API in the same shape that
 * the previous monolithic `src/main/marketplace.ts` exposed, so callers
 * (`ipc.ts`, `agents/runner.ts`, `director/runner.ts`, `index.ts`) keep
 * working unchanged.
 *
 * Internals (sanitizeId, row coercion helpers, frontmatter parser,
 * subset materializer, subset cache, path-traversal guard, skillsForRole,
 * pluginDirForSubscription) live in the sub-modules but are deliberately
 * NOT surfaced here — they're implementation details shared between
 * sources / subscriptions / loadout / telemetry, not part of the
 * marketplace's public surface.
 */

export {
  // Types
  type BundleManifest,
  type SkillSourceRow,
  type ChangelogEntry,
  // Path resolvers
  sourceDir,
  marketplaceJsonPath,
  bundlePluginDir,
  // Sync
  probeGit,
  syncSource,
  // Bundle access
  loadBundles,
  findBundle,
  // Changelog
  getSourceChangelog,
  // Source CRUD
  listSources,
  getSource,
  ensureSource,
  removeSource,
  setSourceEnabled,
  recordSourceSync,
} from './sources';

export {
  // Types
  type SelectedSkills,
  type ProjectSubscriptionRow,
  type BundleSkillInfo,
  // Subscription CRUD
  listSubscriptions,
  subscribeBundle,
  unsubscribeBundle,
  setSubscriptionSkills,
  setSubscriptionRoles,
  acknowledgeBundleVersion,
  moveSubscription,
  // Skill enumeration
  listBundleSkills,
  readSkillContent,
  availableSkillsByRole,
  // Plugin-dir resolution (used by the runner each spawn)
  pluginDirsForProject,
} from './subscriptions';

export {
  type LoadoutEntry,
  type LoadoutReport,
  resolveLoadout,
} from './loadout';

export {
  type SkillFireCount,
  bumpSkillFire,
  getSkillFireCounts,
  attributePathToSkill,
} from './telemetry';
