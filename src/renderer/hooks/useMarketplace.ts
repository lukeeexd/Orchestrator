import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  MarketplaceBundleSkillView,
  MarketplaceBundleView,
  MarketplaceChangelogEntry,
  MarketplaceSelectedSkills,
  MarketplaceSourceView,
  MarketplaceSubscriptionView,
} from '../../shared/ipc';
import { MARKETPLACE_GLOBAL_SCOPE_ID } from '../../shared/ipc';

interface UseMarketplaceResult {
  sources: MarketplaceSourceView[];
  /** Bundles loaded per source. Empty until the source has been synced and the renderer has fetched the manifest. */
  bundlesBySource: Record<string, MarketplaceBundleView[]>;
  /** Union of global subs + active-project subs, deduped by (sourceId, bundleId) — global wins on conflict. */
  subscriptions: MarketplaceSubscriptionView[];
  /** Subscriptions whose current bundle version is ahead of installed_version → "update available". */
  pendingUpdates: MarketplaceSubscriptionView[];
  refreshSource: (sourceId: string) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Install a bundle. `scope` defaults to 'global' — most bundles
   * make sense across projects and the user would rather install once
   * than re-pick per project. 'project' scopes it to the current
   * active project.
   */
  subscribe: (
    sourceId: string,
    bundleId: string,
    scope?: 'global' | 'project',
  ) => Promise<{ ok: boolean; error?: string }>;
  unsubscribe: (
    sourceId: string,
    bundleId: string,
    scope: 'global' | 'project',
  ) => Promise<void>;
  ackUpdate: (
    sourceId: string,
    bundleId: string,
    scope: 'global' | 'project',
  ) => Promise<void>;
  setRoles: (
    sourceId: string,
    bundleId: string,
    scope: 'global' | 'project',
    roles: string[] | null,
  ) => Promise<void>;
  /** Flip a subscription's scope (global ↔ project). Preserves installed_version + roles. */
  moveScope: (
    sourceId: string,
    bundleId: string,
    to: 'global' | 'project',
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Add a new marketplace source by GitHub repo. Synchronous first sync. */
  addSource: (
    repo: string,
    branch?: string,
  ) => Promise<{ ok: boolean; sourceId?: string; error?: string }>;
  /** Remove a marketplace source. Default source can't be removed (handler refuses). */
  removeSource: (
    sourceId: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Toggle a source's enabled flag. */
  setSourceEnabled: (sourceId: string, enabled: boolean) => Promise<void>;
  /** Enumerate the skills inside a bundle. One-shot loader; not cached. */
  listBundleSkills: (
    sourceId: string,
    bundleId: string,
  ) => Promise<MarketplaceBundleSkillView[]>;
  /**
   * Read the full SKILL.md text for a specific skill in a bundle.
   * Returns null when the file isn't on disk (source not synced,
   * skill removed upstream, etc.).
   */
  readSkill: (
    sourceId: string,
    bundleId: string,
    skillId: string,
  ) => Promise<string | null>;
  /**
   * Set the per-skill picks on a subscription. Pass `null` for "all
   * skills in the bundle", a flat `string[]` for "these skills for
   * every enabled role" (legacy Pick modal form), or a
   * `Record<role, string[]>` for per-role granularity.
   */
  setSkills: (
    sourceId: string,
    bundleId: string,
    scope: 'global' | 'project',
    skills: MarketplaceSelectedSkills,
  ) => Promise<void>;
  /** Fetch changelog entries between two versions for a source. */
  getChangelog: (
    sourceId: string,
    fromVersion: string | null,
    toVersion: string,
  ) => Promise<MarketplaceChangelogEntry[]>;
  /** Re-fetch sources + bundles + subscriptions from main. */
  reload: () => Promise<void>;
}

/**
 * Renderer-side state for the Skill Marketplace screen. One projectId
 * scope per hook instance — subscriptions are always for the currently-
 * active project. Sources & bundles are global (one cache shared
 * across projects).
 */
export function useMarketplace(projectId: string | null): UseMarketplaceResult {
  const [sources, setSources] = useState<MarketplaceSourceView[]>([]);
  const [bundlesBySource, setBundlesBySource] = useState<
    Record<string, MarketplaceBundleView[]>
  >({});
  const [subscriptions, setSubscriptions] = useState<
    MarketplaceSubscriptionView[]
  >([]);

  const reloadSubs = useCallback(async (): Promise<
    MarketplaceSubscriptionView[]
  > => {
    // Always pull globals + the active project's subs. Project subs
    // come FIRST so on (sourceId, bundleId) collision the project's
    // role / skill customization wins (matches the runner's dedupe
    // order). A bundle present at both scopes surfaces as project-
    // scoped in the UI.
    const projectSubs = projectId
      ? await window.api.listMarketplaceSubscriptions(projectId)
      : [];
    const globals = await window.api.listMarketplaceSubscriptions(
      MARKETPLACE_GLOBAL_SCOPE_ID,
    );
    const seen = new Set<string>();
    const out: MarketplaceSubscriptionView[] = [];
    for (const s of [...projectSubs, ...globals]) {
      const key = `${s.sourceId}\x00${s.bundleId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
    return out;
  }, [projectId]);

  const reload = useCallback(async () => {
    const src = await window.api.listMarketplaceSources();
    setSources(src);
    const bundlesMap: Record<string, MarketplaceBundleView[]> = {};
    await Promise.all(
      src.map(async (s) => {
        bundlesMap[s.id] = await window.api.listMarketplaceBundles(s.id);
      }),
    );
    setBundlesBySource(bundlesMap);
    setSubscriptions(await reloadSubs());
  }, [reloadSubs]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Subscribe to source patches (sync started / completed / errored)
  // so the UI's spinner + error chip + last-sync-time stay live.
  useEffect(() => {
    const off = window.api.onMarketplaceSourcePatch(({ sourceId, patch }) => {
      setSources((prev) =>
        prev.map((s) => (s.id === sourceId ? { ...s, ...patch } : s)),
      );
      // A sync that pushed a new SHA may have changed the
      // marketplace.json (new bundles, version bumps). Pull the bundles
      // fresh so the UI reflects it.
      if (patch.lastSyncSha !== undefined) {
        void window.api.listMarketplaceBundles(sourceId).then((bs) => {
          setBundlesBySource((prev) => ({ ...prev, [sourceId]: bs }));
        });
      }
    });
    return off;
  }, []);

  // Subscription-change broadcast: keeps multiple hook instances (e.g.
  // App for the rail badge + MarketplaceScreen for the grid) in sync
  // after one of them mutates via subscribe / unsubscribe / ack /
  // move. We listen for matches against the active project AND the
  // global sentinel — both can change the effective union the hook
  // exposes.
  useEffect(() => {
    const off = window.api.onMarketplaceSubscriptionsChanged(
      ({ projectId: pid }) => {
        if (pid !== projectId && pid !== MARKETPLACE_GLOBAL_SCOPE_ID) return;
        void reloadSubs().then(setSubscriptions);
      },
    );
    return off;
  }, [projectId, reloadSubs]);

  // Sources-changed broadcast: fires when a source is added or
  // removed. We re-fetch everything (sources, bundles, subs) since a
  // removed source also cascades subscription deletes.
  useEffect(() => {
    const off = window.api.onMarketplaceSourcesChanged(() => {
      void reload();
    });
    return off;
  }, [reload]);

  const refreshSource = useCallback(
    async (sourceId: string) =>
      window.api.refreshMarketplaceSource(sourceId),
    [],
  );

  const resolveScopeProjectId = useCallback(
    (scope: 'global' | 'project'): string | null => {
      if (scope === 'global') return MARKETPLACE_GLOBAL_SCOPE_ID;
      return projectId;
    },
    [projectId],
  );

  const subscribe = useCallback(
    async (
      sourceId: string,
      bundleId: string,
      scope: 'global' | 'project' = 'global',
    ) => {
      const scopeId = resolveScopeProjectId(scope);
      if (!scopeId) return { ok: false, error: 'no active project' };
      const res = await window.api.subscribeMarketplaceBundle(
        scopeId,
        sourceId,
        bundleId,
      );
      if (res.ok) {
        setSubscriptions(await reloadSubs());
      }
      return res;
    },
    [resolveScopeProjectId, reloadSubs],
  );

  const unsubscribe = useCallback(
    async (
      sourceId: string,
      bundleId: string,
      scope: 'global' | 'project',
    ) => {
      const scopeId = resolveScopeProjectId(scope);
      if (!scopeId) return;
      await window.api.unsubscribeMarketplaceBundle(
        scopeId,
        sourceId,
        bundleId,
      );
      setSubscriptions(await reloadSubs());
    },
    [resolveScopeProjectId, reloadSubs],
  );

  const ackUpdate = useCallback(
    async (
      sourceId: string,
      bundleId: string,
      scope: 'global' | 'project',
    ) => {
      const scopeId = resolveScopeProjectId(scope);
      if (!scopeId) return;
      await window.api.acknowledgeMarketplaceUpdate(
        scopeId,
        sourceId,
        bundleId,
      );
      setSubscriptions(await reloadSubs());
    },
    [resolveScopeProjectId, reloadSubs],
  );

  const setRoles = useCallback(
    async (
      sourceId: string,
      bundleId: string,
      scope: 'global' | 'project',
      roles: string[] | null,
    ) => {
      const scopeId = resolveScopeProjectId(scope);
      if (!scopeId) return;
      await window.api.setMarketplaceBundleRoles(
        scopeId,
        sourceId,
        bundleId,
        roles,
      );
      // The subscriptions-changed broadcast will refresh us — but call
      // explicitly too so the UI updates instantly without waiting for
      // the event round-trip.
      setSubscriptions(await reloadSubs());
    },
    [resolveScopeProjectId, reloadSubs],
  );

  const listBundleSkills = useCallback(
    async (sourceId: string, bundleId: string) =>
      window.api.listMarketplaceBundleSkills(sourceId, bundleId),
    [],
  );

  const readSkill = useCallback(
    async (sourceId: string, bundleId: string, skillId: string) =>
      window.api.readMarketplaceSkill(sourceId, bundleId, skillId),
    [],
  );

  const getChangelog = useCallback(
    async (
      sourceId: string,
      fromVersion: string | null,
      toVersion: string,
    ) =>
      window.api.getMarketplaceChangelog(sourceId, fromVersion, toVersion),
    [],
  );

  const setSkills = useCallback(
    async (
      sourceId: string,
      bundleId: string,
      scope: 'global' | 'project',
      skills: MarketplaceSelectedSkills,
    ) => {
      const scopeId = resolveScopeProjectId(scope);
      if (!scopeId) return;
      await window.api.setMarketplaceBundleSkills(
        scopeId,
        sourceId,
        bundleId,
        skills,
      );
      setSubscriptions(await reloadSubs());
    },
    [resolveScopeProjectId, reloadSubs],
  );

  const addSource = useCallback(
    async (repo: string, branch?: string) => {
      const res = await window.api.addMarketplaceSource(repo, branch);
      if (res.ok) {
        // Pull fresh state right away — the sourcesChanged event will
        // also fire but we don't want a race where the modal closes
        // before the new source is visible.
        await reload();
      }
      return res;
    },
    [reload],
  );

  const setSourceEnabled = useCallback(
    async (sourceId: string, enabled: boolean) => {
      await window.api.setMarketplaceSourceEnabled(sourceId, enabled);
      // No reload — the source-patch broadcast updates `sources` in
      // place. Subscriptions / bundles don't change.
    },
    [],
  );

  const removeSource = useCallback(
    async (sourceId: string) => {
      const res = await window.api.removeMarketplaceSource(sourceId);
      if (res.ok) {
        await reload();
      }
      return res;
    },
    [reload],
  );

  const moveScope = useCallback(
    async (
      sourceId: string,
      bundleId: string,
      to: 'global' | 'project',
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!projectId)
        return { ok: false, error: 'no active project' };
      const from = to === 'global' ? projectId : MARKETPLACE_GLOBAL_SCOPE_ID;
      const dest = to === 'global' ? MARKETPLACE_GLOBAL_SCOPE_ID : projectId;
      const res = await window.api.moveMarketplaceSubscription(
        sourceId,
        bundleId,
        from,
        dest,
      );
      if (res.ok) {
        setSubscriptions(await reloadSubs());
      }
      return res;
    },
    [projectId, reloadSubs],
  );

  const pendingUpdates = useMemo(() => {
    // Disabled sources don't contribute to the rail badge or toast —
    // "disabled" means "stop nagging me about this source".
    const enabledSourceIds = new Set(
      sources.filter((s) => s.enabled).map((s) => s.id),
    );
    return subscriptions.filter((sub) => {
      if (!enabledSourceIds.has(sub.sourceId)) return false;
      const bundles = bundlesBySource[sub.sourceId];
      if (!bundles) return false;
      const current = bundles.find((b) => b.id === sub.bundleId);
      if (!current) return false;
      return sub.installedVersion !== null && current.version !== sub.installedVersion;
    });
  }, [subscriptions, bundlesBySource, sources]);

  return {
    sources,
    bundlesBySource,
    subscriptions,
    pendingUpdates,
    refreshSource,
    subscribe,
    unsubscribe,
    ackUpdate,
    setRoles,
    moveScope,
    addSource,
    removeSource,
    setSourceEnabled,
    listBundleSkills,
    readSkill,
    setSkills,
    getChangelog,
    reload,
  };
}
