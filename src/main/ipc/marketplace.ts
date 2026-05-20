import { ipcMain } from 'electron';
import {
  IpcChannels,
  MARKETPLACE_DEFAULT_SOURCE_ID,
  MARKETPLACE_GLOBAL_SCOPE_ID,
  type MarketplaceBundleView,
  type MarketplaceSourceView,
  type MarketplaceSubscriptionView,
} from '../../shared/ipc';
import * as marketplace from '../marketplace';
import type { IpcContext } from './_shared';

function sourceView(row: marketplace.SkillSourceRow): MarketplaceSourceView {
  return {
    id: row.id,
    repo: row.repo,
    defaultBranch: row.defaultBranch,
    enabled: row.enabled,
    addedAt: row.addedAt,
    lastSyncAt: row.lastSyncAt,
    lastSyncSha: row.lastSyncSha,
  };
}

// L4: roles persisted in the DB are stored as plain strings, but
// the IPC contract narrows to the actual union. Filter through
// the known role set on the way out so a hand-edited row can't
// smuggle a bogus role identifier into the renderer.
const KNOWN_ROLES: ReadonlyArray<
  import('../../shared/types').AgentRole | 'director'
> = ['pm', 'researcher', 'coder', 'qa', 'devops', 'security', 'director'];
const KNOWN_ROLE_SET = new Set<string>(KNOWN_ROLES);

function narrowRoles(
  raw: string[] | null,
): Array<import('../../shared/types').AgentRole | 'director'> | null {
  if (raw === null) return null;
  return raw.filter((r): r is import('../../shared/types').AgentRole | 'director' =>
    KNOWN_ROLE_SET.has(r),
  );
}

/**
 * Normalize a user-typed repo string into the canonical "owner/repo"
 * form we use as a source id. Accepts pasted https URLs, trailing
 * slashes, .git suffixes. Returns null if the result isn't a plausible
 * GitHub slug.
 */
function normalizeRepo(input: string): string | null {
  let s = input.trim();
  s = s.replace(/^https?:\/\/github\.com\//i, '');
  s = s.replace(/\/+$/, '');
  s = s.replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s)) return null;
  return s;
}

export function registerMarketplaceHandlers(ctx: IpcContext): void {
  ipcMain.handle(
    IpcChannels.MarketplaceListSources,
    (): MarketplaceSourceView[] => marketplace.listSources().map(sourceView),
  );

  ipcMain.handle(
    IpcChannels.MarketplaceListBundles,
    (_event, sourceId: string): MarketplaceBundleView[] =>
      marketplace.loadBundles(sourceId).map((b) => ({
        id: b.id,
        source: b.source,
        description: b.description,
        version: b.version,
        category: b.category,
        keywords: b.keywords,
      })),
  );

  ipcMain.handle(
    IpcChannels.MarketplaceListSubscriptions,
    (_event, projectId: string): MarketplaceSubscriptionView[] =>
      marketplace.listSubscriptions(projectId).map((s) => ({
        projectId: s.projectId,
        sourceId: s.sourceId,
        bundleId: s.bundleId,
        subscribedAt: s.subscribedAt,
        installedVersion: s.installedVersion,
        roles: narrowRoles(s.roles),
        selectedSkills: s.selectedSkills,
        scope:
          s.projectId === MARKETPLACE_GLOBAL_SCOPE_ID
            ? ('global' as const)
            : ('project' as const),
      })),
  );

  ipcMain.handle(
    IpcChannels.MarketplaceSubscribe,
    (
      _event,
      projectId: string,
      sourceId: string,
      bundleId: string,
    ): { ok: boolean; error?: string } => {
      const bundle = marketplace.findBundle(sourceId, bundleId);
      if (!bundle) {
        return {
          ok: false,
          error: 'bundle not found — has the source been synced?',
        };
      }
      marketplace.subscribeBundle(
        projectId,
        sourceId,
        bundleId,
        bundle.version,
      );
      ctx.broadcast(IpcChannels.MarketplaceEventSubscriptionsChanged, {
        projectId,
      });
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.MarketplaceUnsubscribe,
    (
      _event,
      projectId: string,
      sourceId: string,
      bundleId: string,
    ): { ok: true } => {
      marketplace.unsubscribeBundle(projectId, sourceId, bundleId);
      ctx.broadcast(IpcChannels.MarketplaceEventSubscriptionsChanged, {
        projectId,
      });
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.MarketplaceRefresh,
    async (
      _event,
      sourceId: string,
    ): Promise<{
      ok: boolean;
      sha?: string;
      changed?: boolean;
      error?: string;
    }> => {
      const source = marketplace.getSource(sourceId);
      if (!source) return { ok: false, error: 'source not found' };
      ctx.broadcast(IpcChannels.MarketplaceEventSourcePatch, {
        sourceId,
        patch: { syncing: true, syncError: undefined },
      });
      try {
        const { sha, changed } = await marketplace.syncSource(source);
        const syncedAt = Date.now();
        marketplace.recordSourceSync(sourceId, sha, syncedAt);
        ctx.broadcast(IpcChannels.MarketplaceEventSourcePatch, {
          sourceId,
          patch: {
            syncing: false,
            lastSyncAt: syncedAt,
            lastSyncSha: sha,
            syncError: undefined,
          },
        });
        return { ok: true, sha, changed };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.broadcast(IpcChannels.MarketplaceEventSourcePatch, {
          sourceId,
          patch: { syncing: false, syncError: msg },
        });
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.MarketplaceAckUpdate,
    (
      _event,
      projectId: string,
      sourceId: string,
      bundleId: string,
    ): { ok: true } => {
      const bundle = marketplace.findBundle(sourceId, bundleId);
      if (bundle) {
        marketplace.acknowledgeBundleVersion(
          projectId,
          sourceId,
          bundleId,
          bundle.version,
        );
        ctx.broadcast(IpcChannels.MarketplaceEventSubscriptionsChanged, {
          projectId,
        });
      }
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.MarketplaceAddSource,
    async (
      _event,
      repo: string,
      branch?: string,
    ): Promise<{ ok: boolean; sourceId?: string; error?: string }> => {
      const normalized = normalizeRepo(repo);
      if (!normalized) {
        return {
          ok: false,
          error: 'Repo must be in the form "owner/repo".',
        };
      }
      const defaultBranch =
        branch && branch.trim().length > 0 ? branch.trim() : 'main';
      const inserted = marketplace.ensureSource({
        id: normalized,
        repo: normalized,
        defaultBranch,
      });
      if (!inserted) {
        return {
          ok: false,
          error: `Source "${normalized}" is already added.`,
        };
      }
      // Run the first sync inline so a bad repo / missing branch / git
      // error surfaces in the modal rather than leaving the user with a
      // broken-looking source row. Roll back the row on failure.
      const row = marketplace.getSource(normalized);
      if (!row) {
        return { ok: false, error: 'failed to read back inserted source' };
      }
      try {
        const { sha } = await marketplace.syncSource(row);
        marketplace.recordSourceSync(normalized, sha, Date.now());
        ctx.broadcast(IpcChannels.MarketplaceEventSourcesChanged, undefined);
        return { ok: true, sourceId: normalized };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        marketplace.removeSource(normalized);
        ctx.broadcast(IpcChannels.MarketplaceEventSourcesChanged, undefined);
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.MarketplaceGetChangelog,
    (
      _event,
      sourceId: string,
      fromVersion: string | null,
      toVersion: string,
    ): marketplace.ChangelogEntry[] =>
      marketplace.getSourceChangelog(sourceId, fromVersion, toVersion),
  );

  ipcMain.handle(
    IpcChannels.MarketplaceListBundleSkills,
    (
      _event,
      sourceId: string,
      bundleId: string,
    ): marketplace.BundleSkillInfo[] =>
      marketplace.listBundleSkills(sourceId, bundleId),
  );

  ipcMain.handle(
    IpcChannels.MarketplaceReadSkill,
    (
      _event,
      sourceId: string,
      bundleId: string,
      skillId: string,
    ): string | null =>
      marketplace.readSkillContent(sourceId, bundleId, skillId),
  );

  ipcMain.handle(
    IpcChannels.MarketplaceResolveLoadout,
    (
      _event,
      projectId: string,
      role: string,
    ): marketplace.LoadoutReport => marketplace.resolveLoadout(projectId, role),
  );

  ipcMain.handle(
    IpcChannels.MarketplaceListFireCounts,
    (
      _event,
      projectId: string,
    ): marketplace.SkillFireCount[] => marketplace.getSkillFireCounts(projectId),
  );

  ipcMain.handle(
    IpcChannels.MarketplaceSetSkills,
    (
      _event,
      projectId: string,
      sourceId: string,
      bundleId: string,
      skills: marketplace.SelectedSkills,
    ): { ok: true } => {
      // Defensive: the renderer is trusted, but the IPC boundary is
      // the right place to coerce shapes so a malformed call can't
      // poison the column. Three valid forms:
      //   null         → all skills
      //   string[]     → flat (every role gets these)
      //   { [r]: [] }  → per-role
      let sanitized: marketplace.SelectedSkills = null;
      if (Array.isArray(skills)) {
        sanitized = skills.filter(
          (s): s is string => typeof s === 'string' && s.length > 0,
        );
      } else if (skills && typeof skills === 'object') {
        const map: Record<string, string[]> = {};
        for (const [role, list] of Object.entries(skills)) {
          if (!Array.isArray(list)) continue;
          map[role] = list.filter(
            (s): s is string => typeof s === 'string' && s.length > 0,
          );
        }
        sanitized = map;
      }
      marketplace.setSubscriptionSkills(
        projectId,
        sourceId,
        bundleId,
        sanitized,
      );
      ctx.broadcast(IpcChannels.MarketplaceEventSubscriptionsChanged, {
        projectId,
      });
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.MarketplaceSetSourceEnabled,
    (
      _event,
      sourceId: string,
      enabled: boolean,
    ): { ok: true } => {
      marketplace.setSourceEnabled(sourceId, !!enabled);
      // Source-row patch covers the per-row state in the renderer; a
      // sourcesChanged broadcast would over-trigger a full reload.
      // The renderer's per-row patcher already handles this kind of
      // update.
      ctx.broadcast(IpcChannels.MarketplaceEventSourcePatch, {
        sourceId,
        patch: { enabled },
      });
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.MarketplaceRemoveSource,
    (_event, sourceId: string): { ok: boolean; error?: string } => {
      if (sourceId === MARKETPLACE_DEFAULT_SOURCE_ID) {
        return {
          ok: false,
          error:
            'The default source cannot be removed (it would be re-seeded on the next launch). Disable it instead.',
        };
      }
      const removed = marketplace.removeSource(sourceId);
      if (!removed) {
        return { ok: false, error: 'source not found' };
      }
      ctx.broadcast(IpcChannels.MarketplaceEventSourcesChanged, undefined);
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.MarketplaceMoveScope,
    (
      _event,
      sourceId: string,
      bundleId: string,
      fromProjectId: string,
      toProjectId: string,
    ): { ok: boolean; error?: string } => {
      const moved = marketplace.moveSubscription(
        sourceId,
        bundleId,
        fromProjectId,
        toProjectId,
      );
      if (!moved) {
        return {
          ok: false,
          error: 'no subscription to move at the source scope',
        };
      }
      // Notify both scopes so the renderer's two parallel calls
      // (project + global) both refresh.
      ctx.broadcast(IpcChannels.MarketplaceEventSubscriptionsChanged, {
        projectId: fromProjectId,
      });
      ctx.broadcast(IpcChannels.MarketplaceEventSubscriptionsChanged, {
        projectId: toProjectId,
      });
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.MarketplaceSetRoles,
    (
      _event,
      projectId: string,
      sourceId: string,
      bundleId: string,
      roles: string[] | null,
    ): { ok: true } => {
      // Defensive: ignore non-string entries in case the renderer
      // hands us something weird; we'd rather store [] than corrupt
      // the JSON. null passes through cleanly = "all roles".
      const sanitized = roles
        ? roles.filter((r): r is string => typeof r === 'string')
        : null;
      marketplace.setSubscriptionRoles(
        projectId,
        sourceId,
        bundleId,
        sanitized,
      );
      ctx.broadcast(IpcChannels.MarketplaceEventSubscriptionsChanged, {
        projectId,
      });
      return { ok: true };
    },
  );
}
