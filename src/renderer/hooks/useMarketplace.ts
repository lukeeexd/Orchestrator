import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  MarketplaceBundleView,
  MarketplaceSourceView,
  MarketplaceSubscriptionView,
} from '../../shared/ipc';

interface UseMarketplaceResult {
  sources: MarketplaceSourceView[];
  /** Bundles loaded per source. Empty until the source has been synced and the renderer has fetched the manifest. */
  bundlesBySource: Record<string, MarketplaceBundleView[]>;
  subscriptions: MarketplaceSubscriptionView[];
  /** Subscriptions whose current bundle version is ahead of installed_version → "update available". */
  pendingUpdates: MarketplaceSubscriptionView[];
  refreshSource: (sourceId: string) => Promise<{ ok: boolean; error?: string }>;
  subscribe: (sourceId: string, bundleId: string) => Promise<{ ok: boolean; error?: string }>;
  unsubscribe: (sourceId: string, bundleId: string) => Promise<void>;
  ackUpdate: (sourceId: string, bundleId: string) => Promise<void>;
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
    if (projectId) {
      setSubscriptions(
        await window.api.listMarketplaceSubscriptions(projectId),
      );
    } else {
      setSubscriptions([]);
    }
  }, [projectId]);

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
  // after one of them mutates via subscribe / unsubscribe / ack.
  useEffect(() => {
    if (!projectId) return;
    const off = window.api.onMarketplaceSubscriptionsChanged(
      ({ projectId: pid }) => {
        if (pid !== projectId) return;
        void window.api
          .listMarketplaceSubscriptions(projectId)
          .then(setSubscriptions);
      },
    );
    return off;
  }, [projectId]);

  const refreshSource = useCallback(
    async (sourceId: string) =>
      window.api.refreshMarketplaceSource(sourceId),
    [],
  );

  const subscribe = useCallback(
    async (sourceId: string, bundleId: string) => {
      if (!projectId) return { ok: false, error: 'no active project' };
      const res = await window.api.subscribeMarketplaceBundle(
        projectId,
        sourceId,
        bundleId,
      );
      if (res.ok) {
        setSubscriptions(
          await window.api.listMarketplaceSubscriptions(projectId),
        );
      }
      return res;
    },
    [projectId],
  );

  const unsubscribe = useCallback(
    async (sourceId: string, bundleId: string) => {
      if (!projectId) return;
      await window.api.unsubscribeMarketplaceBundle(
        projectId,
        sourceId,
        bundleId,
      );
      setSubscriptions(
        await window.api.listMarketplaceSubscriptions(projectId),
      );
    },
    [projectId],
  );

  const ackUpdate = useCallback(
    async (sourceId: string, bundleId: string) => {
      if (!projectId) return;
      await window.api.acknowledgeMarketplaceUpdate(
        projectId,
        sourceId,
        bundleId,
      );
      setSubscriptions(
        await window.api.listMarketplaceSubscriptions(projectId),
      );
    },
    [projectId],
  );

  const pendingUpdates = useMemo(() => {
    return subscriptions.filter((sub) => {
      const bundles = bundlesBySource[sub.sourceId];
      if (!bundles) return false;
      const current = bundles.find((b) => b.id === sub.bundleId);
      if (!current) return false;
      return sub.installedVersion !== null && current.version !== sub.installedVersion;
    });
  }, [subscriptions, bundlesBySource]);

  return {
    sources,
    bundlesBySource,
    subscriptions,
    pendingUpdates,
    refreshSource,
    subscribe,
    unsubscribe,
    ackUpdate,
    reload,
  };
}
