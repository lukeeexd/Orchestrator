import { useMemo, useState } from 'react';
import type {
  MarketplaceBundleView,
  MarketplaceSourceView,
  MarketplaceSubscriptionView,
} from '../../shared/ipc';
import { MARKETPLACE_DEFAULT_SOURCE_ID } from '../../shared/ipc';
import type { Provider } from '../../shared/types';
import { Icon } from './Icon';
import { useMarketplace } from '../hooks/useMarketplace';

interface Props {
  projectId: string | null;
  projectName: string | null;
  /** Active project's agent provider — drives the codex caveat banner. */
  projectProvider: Provider | null;
  /** Active project's effective Director provider — also codex caveat. */
  directorProvider: Provider | null;
}

function timeAgo(ms: number | null): string {
  if (!ms) return 'never';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function MarketplaceScreen({
  projectId,
  projectName,
  projectProvider,
  directorProvider,
}: Props) {
  const mp = useMarketplace(projectId);
  const [addOpen, setAddOpen] = useState(false);
  // Banner condition: the active project has no claude side at all
  // (agents AND Director are codex). In that case, every subscription
  // the user makes here is dormant for *this* project — it'd only
  // apply to claude agents in other projects. Calling that out
  // up-front avoids the "I installed it, why isn't it working?"
  // confusion. Mixed-provider projects (claude Director + codex agents
  // or vice versa) still get something from the marketplace, so we
  // skip the banner there.
  const allCodex =
    projectProvider === 'codex' && directorProvider === 'codex';

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
        <button
          className="tb-btn"
          style={{ height: 22 }}
          onClick={() => setAddOpen(true)}
          title="Add another GitHub-hosted marketplace source"
        >
          <Icon name="plus" size={11} /> Add source
        </button>
      </div>
      <div className="settings-body">
        {allCodex && (
          <div
            className="inline-empty"
            style={{ padding: 14, marginBottom: 12 }}
          >
            <strong>Codex-only project.</strong> Codex's CLI doesn't
            accept a per-spawn <code>--plugin-dir</code>, so the
            bundles you install here won't be loaded for this project's
            agents or Director. Subscriptions are still useful if you
            have other projects on claude — they'll pick up
            global-scope installs there. To wire community skills into
            codex itself, run{' '}
            <code>codex plugin marketplace add &lt;repo&gt;</code> from
            your shell.
          </div>
        )}
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
              removable={source.id !== MARKETPLACE_DEFAULT_SOURCE_ID}
              onRefresh={() => void mp.refreshSource(source.id)}
              onRemove={() => void mp.removeSource(source.id)}
              onSubscribe={(bundleId, scope) =>
                void mp.subscribe(source.id, bundleId, scope)
              }
              onUnsubscribe={(bundleId, scope) =>
                void mp.unsubscribe(source.id, bundleId, scope)
              }
              onAckUpdate={(bundleId, scope) =>
                void mp.ackUpdate(source.id, bundleId, scope)
              }
              onSetRoles={(bundleId, scope, roles) =>
                void mp.setRoles(source.id, bundleId, scope, roles)
              }
              onMoveScope={(bundleId, to) =>
                void mp.moveScope(source.id, bundleId, to)
              }
            />
          ))
        )}
      </div>
      {addOpen && (
        <AddSourceModal
          onCancel={() => setAddOpen(false)}
          onAdd={async (repo, branch) => {
            const res = await mp.addSource(repo, branch);
            if (res.ok) setAddOpen(false);
            return res;
          }}
        />
      )}
    </div>
  );
}

function AddSourceModal({
  onCancel,
  onAdd,
}: {
  onCancel: () => void;
  onAdd: (
    repo: string,
    branch?: string,
  ) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!repo.trim()) {
      setError('Enter a GitHub repo (owner/repo).');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await onAdd(
      repo.trim(),
      branch.trim().length > 0 ? branch.trim() : undefined,
    );
    setBusy(false);
    if (!res.ok) setError(res.error ?? 'failed to add source');
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 520 }}
      >
        <div className="modal-head">
          <span className="title">
            <b>Add marketplace source</b>
          </span>
          <span className="spacer" />
          <button className="icon-btn" onClick={onCancel} title="Cancel">
            <Icon name="x" size={11} />
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <span className="lbl">GitHub repo</span>
            <input
              className="text-input"
              value={repo}
              onChange={(e) => {
                setRepo(e.target.value);
                setError(null);
              }}
              placeholder="owner/repo or https://github.com/owner/repo"
              autoFocus
              spellCheck={false}
            />
            <span
              className="meta"
              style={{
                fontSize: 11,
                color: 'var(--muted)',
                marginTop: 2,
              }}
            >
              The repo must publish a{' '}
              <code>.claude-plugin/marketplace.json</code> manifest. We
              do a shallow git clone of the default branch on add.
            </span>
          </div>
          <div className="field">
            <span className="lbl">Branch (optional)</span>
            <input
              className="text-input"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              spellCheck={false}
            />
          </div>
          {error && (
            <div className="form-error" style={{ marginTop: 6 }}>
              {error}
            </div>
          )}
        </div>
        <div
          className="modal-foot"
          style={{
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
            padding: 12,
            borderTop: '1px solid var(--border)',
          }}
        >
          <button className="tb-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="tb-btn primary"
            onClick={() => void submit()}
            disabled={busy || !repo.trim()}
          >
            {busy ? 'Cloning…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SourceSection({
  source,
  bundles,
  subscriptions,
  removable,
  onRefresh,
  onRemove,
  onSubscribe,
  onUnsubscribe,
  onAckUpdate,
  onSetRoles,
  onMoveScope,
}: {
  source: MarketplaceSourceView;
  bundles: MarketplaceBundleView[];
  subscriptions: MarketplaceSubscriptionView[];
  removable: boolean;
  onRefresh: () => void;
  onRemove: () => void;
  onSubscribe: (bundleId: string, scope: 'global' | 'project') => void;
  onUnsubscribe: (bundleId: string, scope: 'global' | 'project') => void;
  onAckUpdate: (bundleId: string, scope: 'global' | 'project') => void;
  onSetRoles: (
    bundleId: string,
    scope: 'global' | 'project',
    roles: string[] | null,
  ) => void;
  onMoveScope: (bundleId: string, to: 'global' | 'project') => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const subByBundle = useMemo(() => {
    const m = new Map<string, MarketplaceSubscriptionView>();
    for (const s of subscriptions) m.set(s.bundleId, s);
    return m;
  }, [subscriptions]);

  const [filter, setFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | 'all'>('all');
  const [installedOnly, setInstalledOnly] = useState(false);
  const installedBundleIds = useMemo(
    () => new Set(subscriptions.map((s) => s.bundleId)),
    [subscriptions],
  );

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const b of bundles) if (b.category) set.add(b.category);
    return [...set].sort();
  }, [bundles]);

  const filteredBundles = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return bundles.filter((b) => {
      if (installedOnly && !installedBundleIds.has(b.id)) return false;
      if (categoryFilter !== 'all' && b.category !== categoryFilter)
        return false;
      if (!q) return true;
      if (b.id.toLowerCase().includes(q)) return true;
      if (b.description.toLowerCase().includes(q)) return true;
      if (b.keywords?.some((k) => k.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [bundles, filter, categoryFilter, installedOnly, installedBundleIds]);

  const installedCount = subscriptions.length;

  return (
    <section className="settings-section">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
        }}
      >
        <code
          style={{
            fontSize: 12,
            color: 'var(--text)',
            background: 'transparent',
            padding: 0,
          }}
        >
          {source.repo}
        </code>
        <span style={{ color: 'var(--muted-2)' }}>·</span>
        {source.lastSyncSha && (
          <>
            <code
              style={{
                fontSize: 10,
                color: 'var(--muted)',
                background: 'transparent',
                padding: 0,
              }}
              title={source.lastSyncSha}
            >
              {source.lastSyncSha.slice(0, 7)}
            </code>
            <span style={{ color: 'var(--muted-2)' }}>·</span>
          </>
        )}
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          synced {timeAgo(source.lastSyncAt)}
        </span>
        {installedCount > 0 && (
          <>
            <span style={{ color: 'var(--muted-2)' }}>·</span>
            <span style={{ fontSize: 11, color: 'var(--accent)' }}>
              {installedCount} installed
            </span>
          </>
        )}
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
        {removable && (
          <button
            className="tb-btn"
            style={{ height: 22 }}
            onClick={() => setConfirmRemove(true)}
            disabled={source.syncing}
            title="Remove this source — uninstalls all its bundles across every project"
          >
            <Icon name="x" size={11} /> Remove
          </button>
        )}
      </div>
      {confirmRemove && (
        <div
          className="inline-empty"
          style={{
            padding: 14,
            marginBottom: 10,
            border: '1px solid var(--error)',
          }}
        >
          <div style={{ marginBottom: 8 }}>
            Remove <code>{source.repo}</code>?{' '}
            {subscriptions.length > 0 && (
              <>
                This will uninstall{' '}
                <strong>{subscriptions.length} subscribed bundle{
                  subscriptions.length === 1 ? '' : 's'
                }</strong>{' '}
                across every project.
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="tb-btn"
              style={{ height: 22 }}
              onClick={() => setConfirmRemove(false)}
            >
              Cancel
            </button>
            <button
              className="tb-btn primary"
              style={{ height: 22 }}
              onClick={() => {
                setConfirmRemove(false);
                onRemove();
              }}
            >
              <Icon name="x" size={11} /> Confirm remove
            </button>
          </div>
        </div>
      )}
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
              // flex-basis 0 + minWidth 0 so the input can both
              // grow to fill and shrink below content size. Without
              // minWidth: 0 a long-options select on the right
              // squeezes the input down to a few pixels.
              style={{ flex: '1 1 0%', minWidth: 0, height: 24 }}
            />
            <button
              className={'tb-btn' + (installedOnly ? ' primary' : '')}
              style={{ height: 24, flex: '0 0 auto' }}
              onClick={() => setInstalledOnly((v) => !v)}
              disabled={installedCount === 0}
              title={
                installedCount === 0
                  ? 'No bundles installed yet'
                  : installedOnly
                    ? 'Showing only installed bundles — click to show all'
                    : 'Show only installed bundles'
              }
            >
              installed{installedCount > 0 ? ` (${installedCount})` : ''}
            </button>
            {categories.length > 0 && (
              // Reusing model-picker-compact gives the select the
              // chevron-aware right padding + a sensible min-width
              // that fits "all categories" without truncation.
              <select
                className="text-input settings-select model-picker-compact"
                value={categoryFilter}
                onChange={(e) =>
                  setCategoryFilter(e.target.value as typeof categoryFilter)
                }
                style={{ flex: '0 0 auto' }}
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
                  subscription={sub}
                  hasUpdate={!!hasUpdate}
                  onSubscribe={(scope) => onSubscribe(b.id, scope)}
                  onUnsubscribe={(scope) => onUnsubscribe(b.id, scope)}
                  onAckUpdate={(scope) => onAckUpdate(b.id, scope)}
                  onSetRoles={(scope, roles) =>
                    onSetRoles(b.id, scope, roles)
                  }
                  onMoveScope={(to) => onMoveScope(b.id, to)}
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

const ALL_ROLES: { key: string; tint: string }[] = [
  { key: 'pm', tint: '#4ade80' },
  { key: 'researcher', tint: '#60a5fa' },
  { key: 'coder', tint: '#c084fc' },
  { key: 'qa', tint: '#fbbf24' },
  { key: 'devops', tint: '#f97316' },
  { key: 'security', tint: '#f87171' },
  { key: 'director', tint: '#22d3ee' },
];

function BundleCard({
  bundle,
  subscription,
  hasUpdate,
  onSubscribe,
  onUnsubscribe,
  onAckUpdate,
  onSetRoles,
  onMoveScope,
}: {
  bundle: MarketplaceBundleView;
  subscription: MarketplaceSubscriptionView | undefined;
  hasUpdate: boolean;
  onSubscribe: (scope: 'global' | 'project') => void;
  onUnsubscribe: (scope: 'global' | 'project') => void;
  onAckUpdate: (scope: 'global' | 'project') => void;
  onSetRoles: (
    scope: 'global' | 'project',
    roles: string[] | null,
  ) => void;
  onMoveScope: (to: 'global' | 'project') => void;
}) {
  const subscribed = !!subscription;
  const scope: 'global' | 'project' = subscription?.scope ?? 'global';
  const roles = subscription?.roles ?? null;

  // A chip is "on" when roles is null (all-roles legacy default) or
  // when it includes this role. Click toggles.
  const isRoleOn = (key: string) => roles === null || roles.includes(key);

  const toggleRole = (key: string) => {
    const currentlyOn = isRoleOn(key);
    if (roles === null) {
      // First per-role edit: start from "all roles", remove the
      // clicked one. The next click can re-add.
      const next = ALL_ROLES.map((r) => r.key).filter((k) => k !== key);
      onSetRoles(scope, next);
      return;
    }
    if (currentlyOn) {
      onSetRoles(scope, roles.filter((k) => k !== key));
    } else {
      // Add and keep ALL_ROLES ordering so the wire shape stays
      // deterministic.
      const next = ALL_ROLES.map((r) => r.key).filter(
        (k) => roles.includes(k) || k === key,
      );
      onSetRoles(scope, next);
    }
  };

  const resetRoles = () => onSetRoles(scope, null);
  const isAllRolesOn = roles === null;
  const isNoRolesOn = roles !== null && roles.length === 0;
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
        {subscribed && (
          <span
            className="badge"
            style={{
              background: 'var(--sub-2)',
              color:
                scope === 'global' ? 'var(--accent)' : 'var(--waiting)',
              fontSize: 9,
            }}
            title={
              scope === 'global'
                ? 'Installed globally — loaded in every project'
                : 'Installed for this project only'
            }
          >
            {scope}
          </span>
        )}
        {hasUpdate && (
          <span
            className="badge"
            style={{
              background: 'var(--sub-2)',
              color: 'var(--waiting)',
              fontSize: 9,
            }}
            title={`Installed v${subscription?.installedVersion}, current v${bundle.version}`}
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
      {subscribed && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            marginTop: 2,
            paddingTop: 6,
            borderTop: '1px solid var(--border)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 6,
            }}
          >
            <span
              style={{
                fontSize: 10,
                color: 'var(--muted-2)',
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}
            >
              load for
            </span>
            <span className="spacer" />
            {!isAllRolesOn && (
              <button
                className="tb-btn"
                style={{
                  height: 18,
                  fontSize: 10,
                  padding: '0 6px',
                }}
                onClick={resetRoles}
                title="Reset to all roles (legacy default)"
              >
                all
              </button>
            )}
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 3,
            }}
          >
            {ALL_ROLES.map((r) => {
              const on = isRoleOn(r.key);
              return (
                <button
                  key={r.key}
                  onClick={() => toggleRole(r.key)}
                  title={
                    on
                      ? `Loaded for ${r.key} — click to disable`
                      : `Skipped for ${r.key} — click to enable`
                  }
                  style={{
                    background: on
                      ? `${r.tint}22`
                      : 'transparent',
                    border: on
                      ? `1px solid ${r.tint}66`
                      : '1px solid var(--border)',
                    color: on ? r.tint : 'var(--muted-2)',
                    fontSize: 10,
                    padding: '1px 6px',
                    borderRadius: 3,
                    cursor: 'pointer',
                  }}
                >
                  {r.key}
                </button>
              );
            })}
          </div>
          {isNoRolesOn && (
            <span
              style={{
                fontSize: 10,
                color: 'var(--muted)',
                fontStyle: 'italic',
              }}
            >
              No roles selected — bundle is subscribed but no agent
              loads it.
            </span>
          )}
        </div>
      )}
      <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
        {subscribed ? (
          <>
            {hasUpdate && (
              <button
                className="tb-btn primary"
                style={{ height: 22 }}
                onClick={() => onAckUpdate(scope)}
                title={`Acknowledge upgrade to v${bundle.version}`}
              >
                <Icon name="check" size={11} /> Update
              </button>
            )}
            <button
              className="tb-btn"
              style={{ height: 22 }}
              onClick={() => onUnsubscribe(scope)}
              title={
                scope === 'global'
                  ? 'Uninstall globally — no project will load this bundle anymore'
                  : 'Uninstall from this project — global subscriptions in other projects are unaffected'
              }
            >
              <Icon name="x" size={11} /> Remove
            </button>
            <button
              className="tb-btn"
              style={{ height: 22, fontSize: 11 }}
              onClick={() =>
                onMoveScope(scope === 'global' ? 'project' : 'global')
              }
              title={
                scope === 'global'
                  ? 'Scope this bundle to the active project only — other projects will no longer load it'
                  : 'Make this bundle global — every project will load it'
              }
            >
              {scope === 'global' ? 'Make project-only' : 'Make global'}
            </button>
          </>
        ) : (
          <>
            <button
              className="tb-btn primary"
              style={{ height: 22 }}
              onClick={() => onSubscribe('global')}
              title="Install globally — every project's claude spawns load this bundle. Most bundles work fine across projects."
            >
              <Icon name="check" size={11} /> Install
            </button>
            <button
              className="tb-btn"
              style={{ height: 22, fontSize: 11 }}
              onClick={() => onSubscribe('project')}
              title="Install only for the active project — other projects won't see this bundle."
            >
              for project
            </button>
          </>
        )}
      </div>
    </div>
  );
}
