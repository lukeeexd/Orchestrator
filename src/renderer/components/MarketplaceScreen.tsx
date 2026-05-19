import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  MarketplaceBundleSkillView,
  MarketplaceBundleView,
  MarketplaceChangelogEntry,
  MarketplaceLoadoutReport,
  MarketplaceSelectedSkills,
  MarketplaceSkillFireCount,
  MarketplaceSourceView,
  MarketplaceSubscriptionView,
} from '../../shared/ipc';
import {
  MARKETPLACE_DEFAULT_SOURCE_ID,
  MARKETPLACE_RECOMMENDED_DEFAULTS,
} from '../../shared/ipc';
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
  const [recommendedOpen, setRecommendedOpen] = useState(false);
  const [viewTab, setViewTab] = useState<'browse' | 'agents'>('browse');

  // "Already applied" = every recommended bundle is subscribed at the
  // global scope with the same per-role skill map. Any deviation (a
  // role's list is empty when we wanted skills, has extras, or the
  // wrong items) flips it back to not-applied so the user can re-
  // baseline. selectedSkills === null is also a superset and counts
  // as applied — they get everything plus more.
  const recommendedApplied = useMemo(() => {
    const rec = MARKETPLACE_RECOMMENDED_DEFAULTS;
    for (const wanted of rec.bundles) {
      const sub = mp.subscriptions.find(
        (s) => s.sourceId === rec.sourceId && s.bundleId === wanted.bundleId,
      );
      if (!sub) return false;
      const have = sub.selectedSkills;
      if (have === null) continue; // superset; counts as applied
      if (Array.isArray(have)) return false; // flat form ≠ per-role spec
      for (const [role, wantList] of Object.entries(wanted.skillsByRole)) {
        const haveList = have[role] ?? [];
        if (haveList.length !== wantList.length) return false;
        const haveSet = new Set(haveList);
        for (const id of wantList) if (!haveSet.has(id)) return false;
      }
    }
    return true;
  }, [mp.subscriptions]);

  const applyRecommended = async () => {
    const rec = MARKETPLACE_RECOMMENDED_DEFAULTS;
    for (const wanted of rec.bundles) {
      // subscribe is idempotent (INSERT OR REPLACE) — also blanks
      // roles + selectedSkills, which is fine since we set them next.
      await mp.subscribe(rec.sourceId, wanted.bundleId, 'global');
      await mp.setSkills(
        rec.sourceId,
        wanted.bundleId,
        'global',
        wanted.skillsByRole,
      );
      if (wanted.roles !== null) {
        await mp.setRoles(
          rec.sourceId,
          wanted.bundleId,
          'global',
          wanted.roles,
        );
      }
    }
    setRecommendedOpen(false);
  };
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
        <div
          role="tablist"
          style={{
            marginLeft: 16,
            display: 'flex',
            gap: 0,
            borderBottom: '1px solid transparent',
          }}
        >
          {([
            ['browse', 'Browse bundles'],
            ['agents', 'Agent skills'],
          ] as const).map(([key, label]) => {
            const active = viewTab === key;
            return (
              <button
                key={key}
                role="tab"
                aria-selected={active}
                onClick={() => setViewTab(key)}
                className="tb-btn"
                style={{
                  height: 22,
                  borderRadius: 0,
                  borderBottom: active
                    ? '2px solid var(--accent)'
                    : '2px solid transparent',
                  background: 'transparent',
                  color: active ? 'var(--text)' : 'var(--muted)',
                  fontWeight: active ? 600 : 400,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <span className="spacer" />
        <button
          className="tb-btn"
          style={{
            height: 22,
            opacity: recommendedApplied ? 0.55 : 1,
          }}
          onClick={() => setRecommendedOpen(true)}
          title={
            recommendedApplied
              ? 'Recommended setup already applied. Click to review or re-apply.'
              : 'One-click install: subscribes a curated skill set sized for the seven agent roles.'
          }
        >
          {recommendedApplied ? (
            <>
              <Icon name="check" size={11} /> Recommended applied
            </>
          ) : (
            <>
              <Icon name="templates" size={11} /> Recommended setup
            </>
          )}
        </button>
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
        {viewTab === 'agents' ? (
          <AgentSkillsView
            subscriptions={mp.subscriptions}
            sources={mp.sources}
            bundlesBySource={mp.bundlesBySource}
            listBundleSkills={mp.listBundleSkills}
            readSkill={mp.readSkill}
            resolveLoadout={mp.resolveLoadout}
            fireCounts={mp.fireCounts}
            reloadFireCounts={mp.reloadFireCounts}
            setSkills={mp.setSkills}
          />
        ) : mp.sources.length === 0 ? (
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
              onToggleEnabled={() =>
                void mp.setSourceEnabled(source.id, !source.enabled)
              }
              onGetChangelog={(fromV, toV) =>
                mp.getChangelog(source.id, fromV, toV)
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
      {recommendedOpen && (
        <RecommendedSetupModal
          alreadyApplied={recommendedApplied}
          bundles={MARKETPLACE_RECOMMENDED_DEFAULTS.bundles}
          onCancel={() => setRecommendedOpen(false)}
          onApply={applyRecommended}
        />
      )}
    </div>
  );
}

function RecommendedSetupModal({
  alreadyApplied,
  bundles,
  onCancel,
  onApply,
}: {
  alreadyApplied: boolean;
  bundles: typeof MARKETPLACE_RECOMMENDED_DEFAULTS.bundles;
  onCancel: () => void;
  onApply: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 560 }}
      >
        <div className="modal-head">
          <span className="title">
            <b>Recommended setup</b>
          </span>
          <span className="spacer" />
          <button className="icon-btn" onClick={onCancel} title="Cancel">
            <Icon name="x" size={11} />
          </button>
        </div>
        <div className="modal-body">
          <p style={{ marginTop: 0, color: 'var(--muted)', fontSize: 12 }}>
            One-click install of a per-role skill stack. Subscribes
            globally so the picks apply to every project. Each agent
            role gets its own curated list — Claude&apos;s description
            matcher routes inside that role&apos;s set. Re-running
            replaces any existing selection for these bundles.
          </p>
          {bundles.map((b) => (
            <div key={b.bundleId} style={{ marginTop: 10 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  marginBottom: 6,
                  color: 'var(--text)',
                }}
              >
                <code>{b.bundleId}</code>
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '70px 1fr',
                  rowGap: 4,
                  columnGap: 8,
                  fontSize: 10,
                }}
              >
                {Object.entries(b.skillsByRole).map(([role, list]) => (
                  <div
                    key={role}
                    style={{ display: 'contents' }}
                  >
                    <code
                      style={{
                        color: 'var(--muted)',
                        background: 'transparent',
                        padding: 0,
                        textAlign: 'right',
                      }}
                    >
                      {role}
                    </code>
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 4,
                      }}
                    >
                      {list.length === 0 ? (
                        <span
                          style={{ color: 'var(--muted-2)', fontSize: 10 }}
                        >
                          (none)
                        </span>
                      ) : (
                        list.map((s) => (
                          <code
                            key={s}
                            style={{
                              fontSize: 10,
                              padding: '2px 6px',
                              background: 'var(--sub-2)',
                              borderRadius: 3,
                              color: 'var(--text-2)',
                            }}
                          >
                            {s}
                          </code>
                        ))
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {alreadyApplied && (
            <div
              className="inline-empty"
              style={{ padding: 10, marginTop: 12, fontSize: 11 }}
            >
              Already applied. Re-running will re-baseline the skill
              selection (useful after upstream changes).
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
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onApply();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Applying…' : alreadyApplied ? 'Re-apply' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────── Agent skills view ───────────────────────────

const AGENT_ROLES: ReadonlyArray<{ id: string; label: string; hint: string }> = [
  { id: 'director', label: 'Director', hint: 'Plans + supervises agents' },
  { id: 'pm', label: 'PM', hint: 'Decomposes tasks; read-only' },
  { id: 'researcher', label: 'Researcher', hint: 'Reads, web-fetches, summarises' },
  { id: 'coder', label: 'Coder', hint: 'Writes + edits code, runs tests' },
  { id: 'qa', label: 'QA', hint: 'Writes tests, finds regressions' },
  { id: 'devops', label: 'DevOps', hint: 'Builds, deploys, CI' },
  { id: 'security', label: 'Security', hint: 'Audits, threat-models' },
];

/**
 * Compute the effective skill list for `role` from a subscription's
 * current selectedSkills column. Mirrors marketplace.ts skillsForRole
 * exactly — kept in sync because the renderer can't import main code.
 * Returns null for "all skills in the bundle"; an empty array for
 * "none"; or the explicit list.
 */
function effectiveSkillsForRole(
  sub: MarketplaceSubscriptionView,
  role: string,
): string[] | null {
  if (sub.selectedSkills === null) return null;
  if (Array.isArray(sub.selectedSkills)) return sub.selectedSkills;
  return sub.selectedSkills[role] ?? [];
}

/**
 * Build the next selectedSkills value for a subscription after the user
 * toggles a single (role, skillId) cell. Always returns the per-role
 * map form — once the user opens the agent-centric editor and changes
 * anything, the subscription gets pinned to per-role mode so future
 * edits don't accidentally fan out to other roles.
 */
function toggleSkillForRole(
  sub: MarketplaceSubscriptionView,
  role: string,
  skillId: string,
  allSkillIds: string[],
): Record<string, string[]> {
  // 1. Normalize current state into a per-role map.
  const map: Record<string, string[]> = {};
  for (const r of AGENT_ROLES.map((x) => x.id)) {
    const effective = effectiveSkillsForRole(sub, r);
    if (effective === null) {
      // "All skills" — materialize as the full bundle list so the
      // user's first toggle removes one skill, not all of them.
      map[r] = [...allSkillIds];
    } else {
      map[r] = [...effective];
    }
  }
  // 2. Toggle skillId for the target role.
  const idx = map[role].indexOf(skillId);
  if (idx >= 0) {
    map[role].splice(idx, 1);
  } else {
    map[role].push(skillId);
  }
  return map;
}

function AgentSkillsView({
  subscriptions,
  sources,
  bundlesBySource,
  listBundleSkills,
  readSkill,
  resolveLoadout,
  fireCounts,
  reloadFireCounts,
  setSkills,
}: {
  subscriptions: MarketplaceSubscriptionView[];
  sources: MarketplaceSourceView[];
  bundlesBySource: Record<string, MarketplaceBundleView[]>;
  listBundleSkills: (
    sourceId: string,
    bundleId: string,
  ) => Promise<MarketplaceBundleSkillView[]>;
  readSkill: (
    sourceId: string,
    bundleId: string,
    skillId: string,
  ) => Promise<string | null>;
  resolveLoadout: (role: string) => Promise<MarketplaceLoadoutReport>;
  fireCounts: MarketplaceSkillFireCount[];
  reloadFireCounts: () => Promise<void>;
  setSkills: (
    sourceId: string,
    bundleId: string,
    scope: 'global' | 'project',
    skills: MarketplaceSelectedSkills,
  ) => Promise<void>;
}) {
  // Build a lookup so each checkbox can flag its (role, source, bundle,
  // skill) fire count in O(1). Key shape mirrors the table's PK.
  const fireCountByKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const fc of fireCounts) {
      const key = `${fc.role}\x00${fc.sourceId}\x00${fc.bundleId}\x00${fc.skillId}`;
      m.set(key, fc.count);
    }
    return m;
  }, [fireCounts]);
  // Preview state — single modal shared across every checkbox. Stored
  // here (rather than per-checkbox) so opening one closes any other.
  const [previewTarget, setPreviewTarget] = useState<{
    sourceId: string;
    bundleId: string;
    skill: MarketplaceBundleSkillView;
  } | null>(null);
  // Loadout modal target — null means "no modal open"; otherwise the
  // role whose dry-run is being shown.
  const [loadoutRole, setLoadoutRole] = useState<string | null>(null);
  const enabledSourceIds = useMemo(
    () => new Set(sources.filter((s) => s.enabled).map((s) => s.id)),
    [sources],
  );
  const visibleSubs = useMemo(
    () => subscriptions.filter((s) => enabledSourceIds.has(s.sourceId)),
    [subscriptions, enabledSourceIds],
  );

  // Lazy bundle-skill cache. Keyed as `${sourceId}\x00${bundleId}` so
  // a single sub can look up its full skill catalogue once and reuse
  // it across all seven role columns.
  const [skillsCache, setSkillsCache] = useState<
    Record<string, MarketplaceBundleSkillView[]>
  >({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = { ...skillsCache };
      let added = false;
      for (const sub of visibleSubs) {
        const key = `${sub.sourceId}\x00${sub.bundleId}`;
        if (next[key]) continue;
        const list = await listBundleSkills(sub.sourceId, sub.bundleId);
        if (cancelled) return;
        next[key] = list;
        added = true;
      }
      if (!cancelled && added) setSkillsCache(next);
    })();
    return () => {
      cancelled = true;
    };
    // skillsCache deliberately excluded — adding it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSubs, listBundleSkills]);

  if (visibleSubs.length === 0) {
    return (
      <div className="inline-empty" style={{ padding: 24 }}>
        No bundle subscriptions yet. Switch to <strong>Browse bundles</strong>
        {' '}and install one (or hit <strong>Recommended setup</strong> for a
        one-click default).
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          margin: '0 0 12px 0',
        }}
      >
        <p
          style={{
            margin: 0,
            color: 'var(--muted)',
            fontSize: 12,
            flex: 1,
          }}
        >
          Configure which skills each agent role loads from your subscribed
          bundles. Toggling any cell switches that subscription to per-role
          mode — future edits stay scoped to the role you&apos;re editing.
          Numbers next to skill names show how many turns have fired that
          skill in this project.
        </p>
        <button
          className="tb-btn"
          style={{ height: 20, fontSize: 10 }}
          onClick={() => void reloadFireCounts()}
          title="Re-fetch the per-skill fire counts from disk."
        >
          refresh counts
        </button>
      </div>
      {AGENT_ROLES.map((role) => {
        const subsForRole = visibleSubs.filter(
          (sub) => sub.roles === null || sub.roles.includes(role.id),
        );
        return (
          <RoleSkillCard
            key={role.id}
            roleId={role.id}
            roleLabel={role.label}
            roleHint={role.hint}
            subs={subsForRole}
            bundlesBySource={bundlesBySource}
            skillsCache={skillsCache}
            fireCountByKey={fireCountByKey}
            onToggle={async (sub, skillId, allSkillIds) => {
              const next = toggleSkillForRole(
                sub,
                role.id,
                skillId,
                allSkillIds,
              );
              await setSkills(sub.sourceId, sub.bundleId, sub.scope, next);
            }}
            onPreview={(sub, skill) =>
              setPreviewTarget({
                sourceId: sub.sourceId,
                bundleId: sub.bundleId,
                skill,
              })
            }
            onShowLoadout={() => setLoadoutRole(role.id)}
          />
        );
      })}
      {previewTarget && (
        <SkillPreviewModal
          sourceId={previewTarget.sourceId}
          bundleId={previewTarget.bundleId}
          skill={previewTarget.skill}
          readSkill={readSkill}
          onClose={() => setPreviewTarget(null)}
        />
      )}
      {loadoutRole && (
        <LoadoutModal
          role={loadoutRole}
          resolveLoadout={resolveLoadout}
          onClose={() => setLoadoutRole(null)}
        />
      )}
    </div>
  );
}

function RoleSkillCard({
  roleId,
  roleLabel,
  roleHint,
  subs,
  bundlesBySource,
  skillsCache,
  fireCountByKey,
  onToggle,
  onPreview,
  onShowLoadout,
}: {
  roleId: string;
  roleLabel: string;
  roleHint: string;
  subs: MarketplaceSubscriptionView[];
  bundlesBySource: Record<string, MarketplaceBundleView[]>;
  skillsCache: Record<string, MarketplaceBundleSkillView[]>;
  fireCountByKey: Map<string, number>;
  onToggle: (
    sub: MarketplaceSubscriptionView,
    skillId: string,
    allSkillIds: string[],
  ) => void;
  onPreview: (
    sub: MarketplaceSubscriptionView,
    skill: MarketplaceBundleSkillView,
  ) => void;
  onShowLoadout: () => void;
}) {
  return (
    <section
      className="settings-section"
      style={{ marginBottom: 12, padding: 12 }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          marginBottom: 8,
        }}
      >
        <strong style={{ fontSize: 13 }}>{roleLabel}</strong>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{roleHint}</span>
        <span className="spacer" />
        <button
          className="tb-btn"
          style={{ height: 20, fontSize: 10 }}
          onClick={onShowLoadout}
          title="Show what a fresh agent of this role would actually receive at spawn time — the resolved --plugin-dir paths, skills, and a rough context-budget estimate."
        >
          show loadout
        </button>
      </div>
      {subs.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--muted-2)' }}>
          No bundles bound to this role. (Bundles default to all-roles; if
          this role is empty, check the bundle&apos;s role chips in
          Browse bundles.)
        </div>
      ) : (
        subs.map((sub) => {
          const cacheKey = `${sub.sourceId}\x00${sub.bundleId}`;
          const allSkills = skillsCache[cacheKey];
          const bundle = (bundlesBySource[sub.sourceId] ?? []).find(
            (b) => b.id === sub.bundleId,
          );
          const effective = effectiveSkillsForRole(sub, roleId);
          // null → checked = all; empty array → checked = none;
          // list → checked = list.
          const isAll = effective === null;
          const checkedSet = new Set<string>(effective ?? []);
          return (
            <div
              key={cacheKey}
              style={{
                marginTop: 6,
                padding: '8px 10px',
                background: 'var(--sub)',
                borderRadius: 4,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: 6,
                  fontSize: 11,
                }}
              >
                <code>{sub.bundleId}</code>
                <span style={{ color: 'var(--muted-2)' }}>·</span>
                <span style={{ color: 'var(--muted)' }}>
                  {sub.scope === 'global' ? 'global' : 'project-scoped'}
                </span>
                {bundle?.version && (
                  <>
                    <span style={{ color: 'var(--muted-2)' }}>·</span>
                    <span style={{ color: 'var(--muted)' }}>
                      v{bundle.version}
                    </span>
                  </>
                )}
              </div>
              {allSkills === undefined ? (
                <div style={{ fontSize: 11, color: 'var(--muted-2)' }}>
                  Loading skills…
                </div>
              ) : allSkills.length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--muted-2)' }}>
                  This bundle has no skills.
                </div>
              ) : (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns:
                      'repeat(auto-fill, minmax(200px, 1fr))',
                    gap: 4,
                  }}
                >
                  {allSkills.map((s) => {
                    const checked = isAll || checkedSet.has(s.id);
                    const allSkillIds = allSkills.map((x) => x.id);
                    const fireKey = `${roleId}\x00${sub.sourceId}\x00${sub.bundleId}\x00${s.id}`;
                    const fires = fireCountByKey.get(fireKey) ?? 0;
                    // Dim chip: skill is checked but has never fired.
                    // Useful prune signal — the user enabled it but
                    // the auto-loader never picked it for any task.
                    const looksUnused = checked && fires === 0;
                    return (
                      <div
                        key={s.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          fontSize: 11,
                          color: checked ? 'var(--text)' : 'var(--muted-2)',
                          padding: '2px 4px',
                          borderRadius: 3,
                        }}
                      >
                        <label
                          title={s.description ?? s.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            cursor: 'pointer',
                            flex: 1,
                            minWidth: 0,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              onToggle(sub, s.id, allSkillIds)
                            }
                            style={{ margin: 0 }}
                          />
                          <span
                            style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {s.name ?? s.id}
                          </span>
                        </label>
                        {fires > 0 ? (
                          <span
                            title={`Fired ${fires} time${fires === 1 ? '' : 's'} for ${roleLabel} in this project`}
                            style={{
                              fontSize: 9,
                              padding: '1px 5px',
                              borderRadius: 8,
                              background: 'var(--sub-2)',
                              color: 'var(--text-2)',
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          >
                            {fires}×
                          </span>
                        ) : looksUnused ? (
                          <span
                            title="Enabled but never fired in this project — candidate for trimming."
                            style={{
                              fontSize: 9,
                              padding: '1px 5px',
                              borderRadius: 8,
                              background: 'transparent',
                              border: '1px dashed var(--border)',
                              color: 'var(--muted-2)',
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          >
                            0×
                          </span>
                        ) : null}
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => onPreview(sub, s)}
                          title={`Show the SKILL.md for ${s.id}`}
                          style={{
                            padding: 2,
                            color: 'var(--muted)',
                            background: 'transparent',
                            border: 0,
                            cursor: 'pointer',
                          }}
                        >
                          <Icon name="file" size={11} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}

function LoadoutModal({
  role,
  resolveLoadout,
  onClose,
}: {
  role: string;
  resolveLoadout: (role: string) => Promise<MarketplaceLoadoutReport>;
  onClose: () => void;
}) {
  const [report, setReport] = useState<MarketplaceLoadoutReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void resolveLoadout(role)
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [resolveLoadout, role]);

  const roleLabel =
    AGENT_ROLES.find((r) => r.id === role)?.label ?? role;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 720,
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div className="modal-head">
          <span className="title">
            <b>{roleLabel} loadout</b>
            <span
              style={{
                marginLeft: 8,
                color: 'var(--muted)',
                fontSize: 11,
                fontWeight: 400,
              }}
            >
              dry-run — what a fresh <code>{role}</code> spawn would receive
            </span>
          </span>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} title="Close">
            <Icon name="x" size={11} />
          </button>
        </div>
        <div
          className="modal-body"
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: 12,
          }}
        >
          {report === null && !error && (
            <div className="inline-empty" style={{ padding: 18 }}>
              Resolving…
            </div>
          )}
          {error && (
            <div className="form-error">Failed to resolve loadout: {error}</div>
          )}
          {report && (
            <>
              <div
                style={{
                  marginBottom: 12,
                  padding: 10,
                  background: 'var(--sub-2)',
                  borderRadius: 4,
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >
                <div>
                  <strong>{report.totalSkills}</strong>{' '}
                  {report.totalSkills === 1 ? 'skill' : 'skills'} across{' '}
                  <strong>{report.entries.length}</strong>{' '}
                  {report.entries.length === 1 ? 'bundle' : 'bundles'}.
                </div>
                <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 4 }}>
                  ~{report.approxFrontmatterChars.toLocaleString()} chars
                  of skill-frontmatter added to the agent&apos;s system
                  prompt. Full <code>SKILL.md</code> bodies only load
                  on-demand when a skill triggers.
                </div>
              </div>
              {report.entries.length === 0 ? (
                <div className="inline-empty" style={{ padding: 18 }}>
                  No skills load for this role. Agents will spawn with only
                  their base toolset.
                </div>
              ) : (
                report.entries.map((entry) => (
                  <div
                    key={`${entry.sourceId}\x00${entry.bundleId}`}
                    style={{
                      marginBottom: 10,
                      padding: 10,
                      background: 'var(--sub)',
                      borderRadius: 4,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 6,
                        marginBottom: 4,
                        fontSize: 12,
                      }}
                    >
                      <code>{entry.bundleId}</code>
                      <span style={{ color: 'var(--muted-2)' }}>·</span>
                      <span style={{ color: 'var(--muted)', fontSize: 11 }}>
                        {entry.scope}
                      </span>
                      <span style={{ color: 'var(--muted-2)' }}>·</span>
                      <span style={{ color: 'var(--muted)', fontSize: 11 }}>
                        {entry.skills.length}{' '}
                        {entry.skills.length === 1 ? 'skill' : 'skills'}
                      </span>
                    </div>
                    {entry.pluginDir && (
                      <div
                        style={{
                          fontSize: 10,
                          color: 'var(--muted-2)',
                          marginBottom: 6,
                          fontFamily:
                            '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
                          wordBreak: 'break-all',
                        }}
                        title={entry.pluginDir}
                      >
                        --plugin-dir {entry.pluginDir}
                      </div>
                    )}
                    {entry.warning && (
                      <div
                        className="form-error"
                        style={{
                          fontSize: 11,
                          marginBottom: 6,
                          padding: '4px 8px',
                        }}
                      >
                        ⚠ {entry.warning}
                      </div>
                    )}
                    {entry.skills.length > 0 && (
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 4,
                        }}
                      >
                        {entry.skills.map((s) => (
                          <code
                            key={s.id}
                            title={s.description ?? s.id}
                            style={{
                              fontSize: 10,
                              padding: '2px 6px',
                              background: 'var(--sub-2)',
                              borderRadius: 3,
                              color: 'var(--text-2)',
                            }}
                          >
                            {s.id}
                          </code>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </>
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
          <button className="tb-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Strip the YAML frontmatter block from a SKILL.md (everything between
 * the leading `---` and the next `---` on its own line). The modal's
 * header already surfaces name + description, so re-rendering the raw
 * YAML in the body would be redundant. If the file doesn't start with
 * `---`, returns the input unchanged.
 */
function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw;
  // Look for the closing `---` on its own line (with optional
  // leading/trailing whitespace, tolerating CRLF).
  const end = raw.search(/\r?\n---\s*(\r?\n|$)/);
  if (end < 0) return raw;
  const afterClose = raw.indexOf('\n', end + 1);
  if (afterClose < 0) return '';
  return raw.slice(afterClose + 1).replace(/^\s+/, '');
}

function SkillPreviewModal({
  sourceId,
  bundleId,
  skill,
  readSkill,
  onClose,
}: {
  sourceId: string;
  bundleId: string;
  skill: MarketplaceBundleSkillView;
  readSkill: (
    sourceId: string,
    bundleId: string,
    skillId: string,
  ) => Promise<string | null>;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readSkill(sourceId, bundleId, skill.id)
      .then((raw) => {
        if (cancelled) return;
        setContent(raw);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [readSkill, sourceId, bundleId, skill.id]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 760,
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div className="modal-head">
          <span className="title">
            <b>{skill.name ?? skill.id}</b>
            <span
              style={{
                marginLeft: 8,
                color: 'var(--muted)',
                fontSize: 11,
                fontWeight: 400,
              }}
            >
              <code>{bundleId}/{skill.id}</code>
            </span>
          </span>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} title="Close">
            <Icon name="x" size={11} />
          </button>
        </div>
        <div
          className="modal-body"
          style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12 }}
        >
          {skill.description && (
            <p
              style={{
                margin: '0 0 12px 0',
                color: 'var(--muted)',
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              {skill.description}
            </p>
          )}
          {content === undefined && !error && (
            <div className="inline-empty" style={{ padding: 18 }}>
              Loading SKILL.md…
            </div>
          )}
          {error && (
            <div className="form-error">
              Failed to read SKILL.md: {error}
            </div>
          )}
          {content === null && !error && (
            <div className="inline-empty" style={{ padding: 18 }}>
              No SKILL.md found on disk. The source may not be synced
              yet, or the skill was removed upstream — refresh the
              source from Browse bundles and try again.
            </div>
          )}
          {typeof content === 'string' && (
            <div className="md-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {stripFrontmatter(content)}
              </ReactMarkdown>
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
          <button className="tb-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
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
  onToggleEnabled,
  onGetChangelog,
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
  onToggleEnabled: () => void;
  onGetChangelog: (
    fromVersion: string | null,
    toVersion: string,
  ) => Promise<MarketplaceChangelogEntry[]>;
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
    <section
      className="settings-section"
      style={{
        // Disabled sources get a desaturated treatment so it's
        // obvious at a glance that none of these are loading. Cards
        // inside remain clickable — the user can still install /
        // remove / pick skills, just nothing fires on spawns until
        // they re-enable.
        opacity: source.enabled ? 1 : 0.55,
      }}
    >
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
        {!source.enabled && (
          <span
            className="badge"
            style={{
              background: 'var(--sub-2)',
              color: 'var(--muted)',
              fontSize: 9,
            }}
            title="Source is disabled — its bundles are not loaded into any claude spawn until re-enabled."
          >
            disabled
          </span>
        )}
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
          onClick={onToggleEnabled}
          title={
            source.enabled
              ? 'Disable this source — its bundles stop loading until re-enabled. Subscriptions + cache are preserved.'
              : 'Enable this source — its subscriptions start loading on the next spawn.'
          }
        >
          {source.enabled ? 'Disable' : 'Enable'}
        </button>
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
                  onGetChangelog={(fromV, toV) =>
                    onGetChangelog(fromV, toV)
                  }
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
  onGetChangelog,
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
  onGetChangelog: (
    fromVersion: string | null,
    toVersion: string,
  ) => Promise<MarketplaceChangelogEntry[]>;
}) {
  const subscribed = !!subscription;
  const scope: 'global' | 'project' = subscription?.scope ?? 'global';
  const roles = subscription?.roles ?? null;
  const selectedSkills = subscription?.selectedSkills ?? null;
  // Derived view for the small "N selected" chip on the bundle card.
  // Three cases:
  //  - null:        "all" (whole bundle loads)
  //  - flat array:  "N selected" (or "none" if empty)
  //  - per-role:    "per-role" (the legacy Pick modal can't edit this
  //                 shape — direct the user to the Agent skills view
  //                 by disabling Pick when this case is in play)
  const skillsSummary: {
    label: string;
    title: string;
    perRole: boolean;
  } = (() => {
    if (selectedSkills === null) {
      return {
        label: 'all',
        title: 'All skills in this bundle are loaded',
        perRole: false,
      };
    }
    if (Array.isArray(selectedSkills)) {
      if (selectedSkills.length === 0) {
        return {
          label: 'none selected',
          title: 'No skills from this bundle are loaded',
          perRole: false,
        };
      }
      return {
        label: `${selectedSkills.length} selected`,
        title: `${selectedSkills.length} of the bundle's skills are loaded for every enabled role`,
        perRole: false,
      };
    }
    // Per-role map
    const roleCount = Object.keys(selectedSkills).filter(
      (r) => (selectedSkills[r] ?? []).length > 0,
    ).length;
    return {
      label: `per-role · ${roleCount} role${roleCount === 1 ? '' : 's'}`,
      title:
        'Per-role skill picks active. Use the Agent skills view (top of Marketplace) to edit.',
      perRole: true,
    };
  })();
  const [changelogOpen, setChangelogOpen] = useState(false);

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
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 4,
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
              skills
            </span>
            <span
              style={{ fontSize: 11, color: 'var(--muted)' }}
              title={skillsSummary.title}
            >
              {skillsSummary.label}
            </span>
            <span className="spacer" />
            <span
              style={{ fontSize: 10, color: 'var(--muted-2)' }}
              title="Edit which skills load for each role in the Agent skills tab."
            >
              edit in Agent skills
            </span>
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
        {subscribed ? (
          <>
            {hasUpdate && (
              <>
                <button
                  className="tb-btn primary"
                  style={{ height: 22 }}
                  onClick={() => onAckUpdate(scope)}
                  title={`Acknowledge upgrade to v${bundle.version}`}
                >
                  <Icon name="check" size={11} /> Update
                </button>
                <button
                  className="tb-btn"
                  style={{ height: 22, fontSize: 11 }}
                  onClick={() => setChangelogOpen(true)}
                  title="See what changed between your installed version and the current one"
                >
                  What&apos;s new
                </button>
              </>
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
      {changelogOpen && subscription && (
        <ChangelogModal
          bundle={bundle}
          installedVersion={subscription.installedVersion}
          onClose={() => setChangelogOpen(false)}
          onLoad={() =>
            onGetChangelog(subscription.installedVersion, bundle.version)
          }
        />
      )}
    </div>
  );
}

function ChangelogModal({
  bundle,
  installedVersion,
  onClose,
  onLoad,
}: {
  bundle: MarketplaceBundleView;
  installedVersion: string | null;
  onClose: () => void;
  onLoad: () => Promise<MarketplaceChangelogEntry[]>;
}) {
  const [entries, setEntries] = useState<
    MarketplaceChangelogEntry[] | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void onLoad()
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [onLoad]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 640,
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div className="modal-head">
          <span className="title">
            <b>What&apos;s new · {bundle.id}</b>
          </span>
          <span
            className="meta"
            style={{ marginLeft: 8, fontSize: 11, color: 'var(--muted)' }}
          >
            {installedVersion ?? 'unknown'} → v{bundle.version}
          </span>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} title="Close">
            <Icon name="x" size={11} />
          </button>
        </div>
        <div
          className="modal-body"
          style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
        >
          {error && (
            <div className="form-error">
              Failed to load changelog: {error}
            </div>
          )}
          {entries === null && !error && (
            <div className="inline-empty" style={{ padding: 18 }}>
              Reading CHANGELOG.md…
            </div>
          )}
          {entries !== null && entries.length === 0 && (
            <div className="inline-empty" style={{ padding: 18 }}>
              No CHANGELOG entries between{' '}
              {installedVersion ? `v${installedVersion}` : 'install'}{' '}
              and v{bundle.version}. The source may not maintain a
              CHANGELOG.md, or the versions aren&apos;t in the same
              format.
            </div>
          )}
          {entries !== null && entries.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              {entries.map((entry, i) => (
                <div
                  key={`${entry.version}-${i}`}
                  style={{
                    padding: 10,
                    background: 'var(--sub)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 8,
                      marginBottom: 6,
                    }}
                  >
                    <strong style={{ fontSize: 12 }}>
                      v{entry.version}
                    </strong>
                    {entry.date && (
                      <span
                        className="meta"
                        style={{ fontSize: 11, color: 'var(--muted)' }}
                      >
                        {entry.date}
                      </span>
                    )}
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      fontSize: 11,
                      lineHeight: 1.5,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--text)',
                    }}
                  >
                    {entry.body}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
            padding: 12,
            borderTop: '1px solid var(--border)',
          }}
        >
          <button className="tb-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

