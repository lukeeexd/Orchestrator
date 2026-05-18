import { useMemo, useState } from 'react';
import type {
  MarketplaceBundleView,
  MarketplaceSourceView,
  MarketplaceSubscriptionView,
} from '../../shared/ipc';
import { Icon } from './Icon';
import { useMarketplace } from '../hooks/useMarketplace';

interface Props {
  projectId: string | null;
  projectName: string | null;
}

function timeAgo(ms: number | null): string {
  if (!ms) return 'never';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function MarketplaceScreen({ projectId, projectName }: Props) {
  const mp = useMarketplace(projectId);

  if (!projectId) {
    return (
      <div className="pane" style={{ flex: 1 }}>
        <div className="pane-head">
          <span className="title">
            <b>Marketplace</b>
          </span>
        </div>
        <div className="empty" style={{ height: 'auto', padding: 32 }}>
          <div className="empty-title" style={{ color: 'var(--text-2)' }}>
            No project
          </div>
          <div className="empty-body">
            Skill subscriptions are stored per project. Create or select one to
            install skill bundles.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pane settings-pane" style={{ flex: 1 }}>
      <div className="pane-head">
        <span className="title">
          <b>Marketplace</b>
        </span>
        <span
          className="meta"
          style={{ marginLeft: 8, fontSize: 11, color: 'var(--muted)' }}
        >
          subscriptions for <code>{projectName ?? 'current project'}</code>
        </span>
        <span className="spacer" />
      </div>
      <div className="settings-body">
        {mp.sources.length === 0 ? (
          <div className="inline-empty" style={{ padding: 24 }}>
            No marketplace sources configured. The default
            <code> alirezarezvani/claude-skills </code>
            source should appear after the first launch sync — give it a
            moment, or restart if it doesn&apos;t show up.
          </div>
        ) : (
          mp.sources.map((source) => (
            <SourceSection
              key={source.id}
              source={source}
              bundles={mp.bundlesBySource[source.id] ?? []}
              subscriptions={mp.subscriptions.filter(
                (s) => s.sourceId === source.id,
              )}
              onRefresh={() => void mp.refreshSource(source.id)}
              onSubscribe={(bundleId) => void mp.subscribe(source.id, bundleId)}
              onUnsubscribe={(bundleId) =>
                void mp.unsubscribe(source.id, bundleId)
              }
              onAckUpdate={(bundleId) => void mp.ackUpdate(source.id, bundleId)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function SourceSection({
  source,
  bundles,
  subscriptions,
  onRefresh,
  onSubscribe,
  onUnsubscribe,
  onAckUpdate,
}: {
  source: MarketplaceSourceView;
  bundles: MarketplaceBundleView[];
  subscriptions: MarketplaceSubscriptionView[];
  onRefresh: () => void;
  onSubscribe: (bundleId: string) => void;
  onUnsubscribe: (bundleId: string) => void;
  onAckUpdate: (bundleId: string) => void;
}) {
  const subByBundle = useMemo(() => {
    const m = new Map<string, MarketplaceSubscriptionView>();
    for (const s of subscriptions) m.set(s.bundleId, s);
    return m;
  }, [subscriptions]);

  const [filter, setFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | 'all'>('all');

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const b of bundles) if (b.category) set.add(b.category);
    return [...set].sort();
  }, [bundles]);

  const filteredBundles = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return bundles.filter((b) => {
      if (categoryFilter !== 'all' && b.category !== categoryFilter)
        return false;
      if (!q) return true;
      if (b.id.toLowerCase().includes(q)) return true;
      if (b.description.toLowerCase().includes(q)) return true;
      if (b.keywords?.some((k) => k.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [bundles, filter, categoryFilter]);

  return (
    <section className="settings-section">
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          marginBottom: 6,
        }}
      >
        <h3 className="settings-h" style={{ margin: 0 }}>
          {source.repo}
        </h3>
        <span
          className="meta"
          style={{ fontSize: 11, color: 'var(--muted)' }}
        >
          {source.lastSyncSha
            ? `${source.lastSyncSha.slice(0, 7)} · `
            : ''}
          last sync {timeAgo(source.lastSyncAt)}
        </span>
        <span className="spacer" />
        <button
          className="tb-btn"
          style={{ height: 22 }}
          onClick={onRefresh}
          disabled={source.syncing}
          title="Re-fetch the source from GitHub"
        >
          {source.syncing ? 'Syncing…' : 'Refresh'}
        </button>
      </div>
      {source.syncError && (
        <div className="form-error" style={{ marginBottom: 8 }}>
          Sync failed: {source.syncError}
        </div>
      )}

      {bundles.length === 0 ? (
        <div className="inline-empty" style={{ padding: 14 }}>
          {source.lastSyncAt
            ? 'No bundles found in this source.'
            : 'Waiting for first sync to complete.'}
        </div>
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              marginBottom: 8,
            }}
          >
            <input
              className="text-input"
              placeholder={`Search ${bundles.length} bundles…`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ flex: 1, height: 24 }}
            />
            {categories.length > 0 && (
              <select
                className="text-input settings-select"
                value={categoryFilter}
                onChange={(e) =>
                  setCategoryFilter(e.target.value as typeof categoryFilter)
                }
                style={{ height: 24 }}
              >
                <option value="all">all categories</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns:
                'repeat(auto-fill, minmax(260px, 1fr))',
              gap: 8,
            }}
          >
            {filteredBundles.map((b) => {
              const sub = subByBundle.get(b.id);
              const hasUpdate =
                sub &&
                sub.installedVersion !== null &&
                sub.installedVersion !== b.version;
              return (
                <BundleCard
                  key={b.id}
                  bundle={b}
                  subscribed={!!sub}
                  hasUpdate={!!hasUpdate}
                  installedVersion={sub?.installedVersion ?? null}
                  onSubscribe={() => onSubscribe(b.id)}
                  onUnsubscribe={() => onUnsubscribe(b.id)}
                  onAckUpdate={() => onAckUpdate(b.id)}
                />
              );
            })}
          </div>
          {filteredBundles.length === 0 && (
            <div
              className="inline-empty"
              style={{ padding: 14, marginTop: 8 }}
            >
              No bundles match the current filter.
            </div>
          )}
        </>
      )}
    </section>
  );
}

function BundleCard({
  bundle,
  subscribed,
  hasUpdate,
  installedVersion,
  onSubscribe,
  onUnsubscribe,
  onAckUpdate,
}: {
  bundle: MarketplaceBundleView;
  subscribed: boolean;
  hasUpdate: boolean;
  installedVersion: string | null;
  onSubscribe: () => void;
  onUnsubscribe: () => void;
  onAckUpdate: () => void;
}) {
  return (
    <div
      className="settings-section"
      style={{
        padding: 10,
        margin: 0,
        background: 'var(--sub)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <strong style={{ fontSize: 12 }}>{bundle.id}</strong>
        <span
          className="meta"
          style={{ fontSize: 10, color: 'var(--muted)' }}
        >
          v{bundle.version}
        </span>
        {hasUpdate && (
          <span
            className="badge"
            style={{
              background: 'var(--sub-2)',
              color: 'var(--waiting)',
              fontSize: 9,
            }}
            title={`Installed v${installedVersion}, current v${bundle.version}`}
          >
            update available
          </span>
        )}
        <span className="spacer" />
        {bundle.category && (
          <span
            className="badge"
            style={{
              background: 'var(--sub-2)',
              color: 'var(--muted)',
              fontSize: 9,
            }}
          >
            {bundle.category}
          </span>
        )}
      </div>
      <p
        className="settings-help"
        style={{ fontSize: 11, margin: 0, lineHeight: 1.4 }}
      >
        {bundle.description}
      </p>
      <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
        {subscribed ? (
          <>
            {hasUpdate && (
              <button
                className="tb-btn primary"
                style={{ height: 22 }}
                onClick={onAckUpdate}
                title={`Acknowledge upgrade to v${bundle.version}`}
              >
                <Icon name="check" size={11} /> Update
              </button>
            )}
            <button
              className="tb-btn"
              style={{ height: 22 }}
              onClick={onUnsubscribe}
              title="Uninstall — agents in this project will no longer load this bundle"
            >
              <Icon name="x" size={11} /> Remove
            </button>
          </>
        ) : (
          <button
            className="tb-btn primary"
            style={{ height: 22 }}
            onClick={onSubscribe}
            title="Install for this project — every claude spawn loads the bundle via --plugin-dir"
          >
            <Icon name="check" size={11} /> Install
          </button>
        )}
      </div>
    </div>
  );
}
