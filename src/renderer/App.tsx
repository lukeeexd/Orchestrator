import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DirectorMessage,
  DirectorMode,
  EffortLevel,
  PlanRow,
  Project,
  Provider,
} from '../shared/types';
import { DEFAULT_EFFORT } from '../shared/efforts';
import { defaultModelForProvider, modelMatchesProvider } from '../shared/models';
import { useLocalStorageState } from './hooks/useLocalStorageState';
import { useAgents } from './hooks/useAgents';
import { useDirector } from './hooks/useDirector';
import { useSettings } from './hooks/useSettings';
import { useProjects } from './hooks/useProjects';
import { useMarketplace } from './hooks/useMarketplace';
import { TopBar, type ViewMode } from './components/TopBar';
import { LeftRail, type RailScreen } from './components/LeftRail';
import { StatusBar } from './components/StatusBar';
import { DirectorPane } from './components/DirectorPane';
import { AgentsPane } from './components/AgentsPane';
import { CanvasView } from './components/CanvasView';
import { Drawer } from './components/Drawer';
import { ResizeHandle } from './components/ResizeHandle';
import { PlaceholderScreen } from './components/PlaceholderScreen';
import { SettingsScreen } from './components/SettingsScreen';
import { ToolsScreen } from './components/ToolsScreen';
import { MarketplaceScreen } from './components/MarketplaceScreen';
import { HistoryScreen } from './components/HistoryScreen';
import { TemplatesScreen } from './components/TemplatesScreen';
import { DocsScreen } from './components/DocsScreen';
import { SaveTemplateDialog } from './components/SaveTemplateDialog';
import { BaseBranchModal } from './components/BaseBranchModal';
import { CliMissingGate } from './components/CliMissingGate';
import { CommandPalette } from './components/CommandPalette';
import { PendingRedirectBanner } from './components/PendingRedirectBanner';
import type { BuiltinAction } from '../shared/builtinCommands';
import {
  ProjectTabs,
  NewProjectForm,
  ConfirmDeleteProject,
} from './components/ProjectTabs';

/**
 * R-Vuln6-2026-05-28: how long auto-mode waits before firing a
 * Director-emitted redirect. Long enough for the user to glance at
 * the banner and hit Cancel if the instruction looks wrong;
 * short enough to preserve the auto-mode "stay out of my way" feel.
 */
const AUTO_REDIRECT_DELAY_MS = 3000;

const PLACEHOLDERS: Record<
  Exclude<
    RailScreen,
    'agents' | 'settings' | 'tools' | 'history' | 'marketplace' | 'docs'
  >,
  { title: string; icon: Parameters<typeof PlaceholderScreen>[0]['icon']; body: string }
> = {
  templates: {
    title: 'Templates',
    icon: 'templates',
    body: 'Saved agent fleets. Pick a template, the Director spawns the matching agents with their system prompts and tool allow-lists already wired.',
  },
};

export function App() {
  const [active, setActive] = useState<RailScreen>('agents');
  const [dirW, setDirW] = useLocalStorageState<number>('orchestrator.dirW', 400);
  const [drawerW, setDrawerW] = useLocalStorageState<number>(
    'orchestrator.drawerW',
    460,
  );
  const [mode, setMode] = useLocalStorageState<DirectorMode>(
    'orchestrator.directorMode',
    'auto',
  );
  const [viewMode, setViewMode] = useLocalStorageState<ViewMode>(
    'orchestrator.viewMode',
    'compact',
  );
  const [drawerCollapsed, setDrawerCollapsed] = useLocalStorageState<boolean>(
    'orchestrator.drawerCollapsed',
    false,
  );
  const [showNewProject, setShowNewProject] = useState(false);
  // Rows captured when the user clicks "Save as template" on a PlanCard.
  // Set → SaveTemplateDialog opens; null → closed.
  const [saveTemplateRows, setSaveTemplateRows] = useState<PlanRow[] | null>(
    null,
  );
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // F14 base-branch modal. Populated on plan accept when autoBranch is on
  // and the workspace is a git repo; the modal resolves through `resolve`
  // and clears the state. Held outside React state via a ref-y resolver
  // because the modal returns a value (the user's choice).
  const [basePrompt, setBasePrompt] = useState<{
    branches: string[];
    current: string | null;
    resolve: (choice: string | null) => void;
  } | null>(null);
  // F1: Ctrl-K command palette state. Opens via the global keymap below
  // and via any future caller (e.g. an empty-state "Try Ctrl-K" hint).
  const [paletteOpen, setPaletteOpen] = useState(false);
  // P2 — onboarding banner state. `needed` reflects the result of the
  // hasWorkspaceMd probe + the per-project dismiss flag in localStorage;
  // `busy` covers the round-trip while the template spawn is in flight.
  const [onboardingNeeded, setOnboardingNeeded] = useState(false);
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [agentCountByProject, setAgentCountByProject] = useState<
    Record<string, number>
  >({});
  // Whether each provider's CLI is on PATH. `null` while we're still
  // probing for the first time. We check both at startup so the gate
  // can be provider-aware — a claude-only user with no codex CLI isn't
  // blocked unless they're sitting on a codex project.
  const [cliStatus, setCliStatus] = useState<Record<Provider, boolean> | null>(
    null,
  );

  useEffect(() => {
    void (async () => {
      const [claudeStatus, codexStatus] = await Promise.all([
        window.api.getCliStatus('claude'),
        window.api.getCliStatus('codex'),
      ]);
      setCliStatus({
        claude: claudeStatus.available,
        codex: codexStatus.available,
      });
    })();
  }, []);

  const { settings } = useSettings();
  const {
    projects,
    activeId: activeProjectId,
    setActive: setActiveProject,
    create: createProject,
    setWorkspace: setProjectWorkspace,
    setDirectorModel: setProjectDirectorModel,
    setDirectorEffort: setProjectDirectorEffort,
    setDirectorProvider: setProjectDirectorProvider,
    setAutoBranch: setProjectAutoBranch,
    setMcpConfig,
    setRoleTools: setProjectRoleTools,
    remove: removeProject,
  } = useProjects();
  const marketplace = useMarketplace(activeProjectId);

  // Transient toast surfacing newly-arrived marketplace bundle updates.
  // The persistent rail badge already shows the count; this is the
  // "hey, something just landed" flash so the user notices without
  // having to glance at the rail.
  const [marketplaceToast, setMarketplaceToast] = useState<{
    count: number;
  } | null>(null);
  // Tracks the last pendingUpdates count we've observed so we only
  // toast on *increases*. null = haven't seen the first reload yet
  // (so we don't toast for updates that were already pending when the
  // app launched).
  const lastSeenPendingUpdatesRef = useRef<number | null>(null);
  useEffect(() => {
    const current = marketplace.pendingUpdates.length;
    const previous = lastSeenPendingUpdatesRef.current;
    lastSeenPendingUpdatesRef.current = current;
    // Initial load → record the count and stay silent.
    if (previous === null) return;
    // Only toast when the count grew, and there's at least one update.
    if (current > previous && current > 0) {
      const newlyAdded = current - previous;
      setMarketplaceToast({ count: newlyAdded });
    }
  }, [marketplace.pendingUpdates.length]);
  // Auto-dismiss after 6s so the toast doesn't linger.
  useEffect(() => {
    if (!marketplaceToast) return;
    const t = setTimeout(() => setMarketplaceToast(null), 6000);
    return () => clearTimeout(t);
  }, [marketplaceToast]);

  const activeProject: Project | null =
    projects.find((p) => p.id === activeProjectId) ?? null;
  const workspace = activeProject?.workspace ?? '';
  // Default chain. Falls through to a provider-appropriate default so a
  // codex project doesn't silently get the global claude default
  // (claude-opus-4-7-1m), which codex would reject as an unknown model.
  const activeProvider = activeProject?.provider ?? 'claude';
  // The Director can opt into a different CLI than the agents via
  // directorProvider. Default → use the project's agent provider, same
  // as before this knob existed.
  const directorProvider =
    activeProject?.directorProvider ?? activeProvider;
  const providerDefaultModel = defaultModelForProvider(activeProvider);
  const directorProviderDefaultModel =
    defaultModelForProvider(directorProvider);
  const fallbackModel =
    activeProvider === 'claude'
      ? settings?.defaultModel ?? providerDefaultModel
      : providerDefaultModel;
  const directorFallbackModel =
    directorProvider === 'claude'
      ? settings?.defaultDirectorModel || directorProviderDefaultModel
      : directorProviderDefaultModel;
  // If the stored directorModel doesn't match the Director's effective
  // provider (e.g. legacy value, or the Director provider was just
  // flipped to one whose model picker hasn't been touched yet), fall
  // through to the provider-appropriate default.
  const persistedDirector =
    activeProject?.directorModel &&
    modelMatchesProvider(activeProject.directorModel, directorProvider)
      ? activeProject.directorModel
      : undefined;
  const directorModel = persistedDirector || directorFallbackModel;
  const fallbackEffort: EffortLevel = settings?.defaultEffort ?? DEFAULT_EFFORT;
  const directorFallbackEffort: EffortLevel =
    settings?.defaultDirectorEffort ?? fallbackEffort;
  const directorEffort: EffortLevel =
    activeProject?.directorEffort || directorFallbackEffort;
  // Spawn-form pre-fill stays on the agent defaults — we don't want a
  // 1M-context Opus Director to silently pre-select Opus for every new
  // worker the user spawns by hand. If the user pinned a project-level
  // Director model/effort, we honour that intent and pre-fill with it
  // (when it matches the provider; otherwise fall through).
  const spawnDefaultModel = persistedDirector || fallbackModel;
  const spawnDefaultEffort: EffortLevel =
    activeProject?.directorEffort || fallbackEffort;

  const { agents, selectedId, setSelectedId, expanded, toggle } = useAgents(
    activeProjectId,
  );
  const { messages, send, busy, refresh: refreshDirector } =
    useDirector(activeProjectId);
  const selectedAgent = agents.find((a) => a.id === selectedId) ?? null;
  const [spawning, setSpawning] = useState(false);

  // Track agent counts per project for the tab badges. Hydrate from registry
  // on mount, then update from broadcast events for all projects (not just
  // the active one).
  useEffect(() => {
    let mounted = true;
    void (async () => {
      // L3: parallel fan-out. The serial await chain made tab-badge
      // hydration scale linearly with project count, which actually
      // showed up as a flicker on cold launch once a handful of
      // projects existed.
      const results = await Promise.all(
        projects.map((p) =>
          window.api.listAgents(p.id).then((list) => ({
            id: p.id,
            count: list.filter(
              (a) => a.status === 'running' || a.status === 'waiting',
            ).length,
          })),
        ),
      );
      if (!mounted) return;
      const counts: Record<string, number> = {};
      for (const r of results) counts[r.id] = r.count;
      setAgentCountByProject(counts);
    })();
    return () => {
      mounted = false;
    };
  }, [projects]);

  useEffect(() => {
    // H9: pull the IPC call out of the setState updater. React's
    // setState updater must be pure — StrictMode invokes it twice
    // in dev, which means a listAgents call lived in there was
    // firing twice per event in development.
    const refreshCount = (projectId: string): void => {
      void window.api.listAgents(projectId).then((list) => {
        const count = list.filter(
          (a) => a.status === 'running' || a.status === 'waiting',
        ).length;
        setAgentCountByProject((p) => ({ ...p, [projectId]: count }));
      });
    };
    const offAgent = window.api.onAgent(({ projectId }) => {
      refreshCount(projectId);
    });
    const offPatch = window.api.onPatch(({ projectId }) => {
      refreshCount(projectId);
    });
    const offRemove = window.api.onAgentRemove(({ projectId }) => {
      refreshCount(projectId);
    });
    return () => {
      offAgent();
      offPatch();
      offRemove();
    };
  }, []);

  const handledPlans = useRef<Set<string>>(new Set());
  const handledRedirects = useRef<Set<string>>(new Set());

  /**
   * R-Vuln6-2026-05-28: auto-mode redirects no longer fire instantly —
   * they queue up, get staged in `pendingRedirect` for a few seconds
   * with a Cancel banner, and only then fire (or get ack'd as cancelled).
   * Queue + processor flag let multiple redirects in quick succession
   * serialize through a single banner — without that, a new redirect
   * arriving during the cancel window would steal the banner from the
   * pending one and the user might cancel the wrong instruction.
   */
  const [pendingRedirect, setPendingRedirect] = useState<{
    messageId: string;
    agentName: string;
    instruction: string;
    firesAt: number;
    cancel: () => void;
  } | null>(null);
  // Queue items capture their own projectId so an ack from a redirect
  // staged before a project switch lands on the right project's audit
  // log, not whatever the user navigated to.
  const redirectQueue = useRef<
    Array<{
      messageId: string;
      agentName: string;
      instruction: string;
      projectId: string;
    }>
  >([]);
  const redirectProcessorRunning = useRef(false);
  // Ref for the async processor: agent state may update mid-loop
  // (a worker spawned in the cancel window should still be findable).
  const agentsRef = useRef(agents);
  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  // M10: drop the dedupe sets on project switch. They tracked
  // message ids local to the previous project and grew unbounded
  // otherwise — every session-long active project accumulated one
  // entry per plan/redirect Director ever emitted.
  useEffect(() => {
    handledPlans.current = new Set();
    handledRedirects.current = new Set();
    // Note: we don't clear `redirectQueue` here — its items carry
    // their own projectId and will ack against the originating
    // project even after the user switches away. The user can still
    // see + cancel the banner during its window.
  }, [activeProjectId]);

  // P2 — recompute the onboarding banner state whenever the active
  // project or its workspace changes. Two reasons to NOT show:
  //   1. user dismissed the banner for this project (localStorage flag)
  //   2. WORKSPACE.md already exists in the workspace (main-side check)
  // Both run in parallel; we only flip needed=true when both checks
  // come back negative.
  useEffect(() => {
    let cancelled = false;
    setOnboardingNeeded(false);
    if (!activeProjectId || !workspace) return;
    const dismissed = (() => {
      try {
        return (
          localStorage.getItem(
            `orchestrator.onboardingDismissed.${activeProjectId}`,
          ) === '1'
        );
      } catch {
        return false;
      }
    })();
    if (dismissed) return;
    void window.api.hasWorkspaceMd(workspace).then((has) => {
      if (cancelled) return;
      if (!has) setOnboardingNeeded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, workspace]);

  const runOnboarding = async () => {
    if (!activeProjectId) return;
    setOnboardingBusy(true);
    try {
      const res = await window.api.useTemplate(
        activeProjectId,
        'builtin-codebase-onboarding',
      );
      if (res.ok) {
        // The synthetic Director message lands via the broadcast; the
        // PlanCard renders inside the chat. Hide the banner — the
        // user has acknowledged it, and if WORKSPACE.md ends up not
        // being produced (Director-paused, agent failed, etc) the
        // banner re-shows next project open.
        setOnboardingNeeded(false);
        // Switch the rail to agents so the user sees the spawned
        // researcher rather than staying on whichever rail prompted
        // this. Director chat is where the plan card lives, so the
        // user might also want that — leaving rail unchanged so the
        // user keeps context.
      }
    } finally {
      setOnboardingBusy(false);
    }
  };

  const skipOnboarding = () => {
    if (!activeProjectId) return;
    try {
      localStorage.setItem(
        `orchestrator.onboardingDismissed.${activeProjectId}`,
        '1',
      );
    } catch {
      /* private window / quota — banner returns next session, fine */
    }
    setOnboardingNeeded(false);
  };

  const spawnPlan = async (
    msg: DirectorMessage,
    rows?: PlanRow[],
  ) => {
    const effectiveRows = rows ?? msg.plan;
    if (!effectiveRows || msg.planAccepted || !activeProjectId) return;
    if (effectiveRows.length === 0) return;
    if (handledPlans.current.has(msg.id)) return;
    handledPlans.current.add(msg.id);
    let ws = workspace;
    if (!ws) {
      const { path } = await window.api.pickWorkspace();
      if (!path) {
        handledPlans.current.delete(msg.id);
        return;
      }
      ws = path;
    }
    // Find the user message that triggered this plan — scan backwards
    // from the plan message to the most recent 'user' entry. Its
    // attachments (typically pasted screenshots) flow through to every
    // agent the plan spawns, so the coder sees the same image the
    // Director did. Skipping intermediate system/handoff messages is
    // important: those don't carry user-supplied attachments.
    const planIdx = messages.findIndex((m) => m.id === msg.id);
    let originatingAttachments: string[] | undefined;
    if (planIdx >= 0) {
      for (let i = planIdx - 1; i >= 0; i--) {
        if (messages[i].who === 'user') {
          const refs = messages[i].attachments;
          if (refs && refs.length > 0) {
            originatingAttachments = refs.map((a) => a.path);
          }
          break;
        }
      }
    }
    // F14: if the project has auto-branch on, fetch the local
    // branch list and ask the user which one to root the scratch
    // branch from. Skip the modal when:
    //   - the toggle is off (no auto-branch), OR
    //   - the workspace isn't a git repo (empty branches list).
    // Cancelling the modal aborts the spawn entirely.
    let baseBranch: string | undefined;
    if (activeProject?.autoBranch === true) {
      const { branches, current } =
        await window.api.listGitBranches(activeProjectId);
      if (branches.length > 0) {
        const choice = await new Promise<string | null>((resolve) => {
          setBasePrompt({ branches, current, resolve });
        });
        setBasePrompt(null);
        if (choice === null) {
          handledPlans.current.delete(msg.id);
          return;
        }
        baseBranch = choice;
      }
    }
    try {
      await window.api.acceptPlan({
        projectId: activeProjectId,
        rows: effectiveRows,
        workspace: ws,
        planMessageId: msg.id,
        ...(baseBranch ? { baseBranch } : {}),
        ...(originatingAttachments
          ? { attachments: originatingAttachments }
          : {}),
      });
    } catch (e) {
      console.error('[orchestrator] spawn failed', e);
      handledPlans.current.delete(msg.id);
    }
  };

  // R-Vuln6-2026-05-28: the dedupe gate moved up into the auto-fire
  // processor — by the time this function runs the redirect has
  // already passed the cancel window. `agentsRef` is read inside so
  // a stale `agents` closure (the processor outlives renders) can't
  // miss a target that arrived during the cancel countdown. The
  // projectId is passed by the caller (captured at enqueue time) so
  // a project switch during the cancel window doesn't redirect the
  // ack to the wrong project's audit log.
  const fireRedirect = async (
    messageId: string,
    agentName: string,
    instruction: string,
    projectId: string,
  ) => {
    const target = agentsRef.current.find((a) => a.name === agentName);
    if (!target) {
      console.warn(`[orchestrator] redirect target not found: @${agentName}`);
      handledRedirects.current.delete(messageId);
      return;
    }
    try {
      const res = await window.api.redirectAgent({
        agentId: target.id,
        body: instruction,
      });
      await window.api.ackDirectorRedirect({
        projectId,
        messageId,
        agentName,
        ok: res.ok,
        error: res.error,
      });
    } catch (e) {
      console.error('[orchestrator] redirect fire failed', e);
      handledRedirects.current.delete(messageId);
    }
  };

  /**
   * R-Vuln6-2026-05-28: stage a redirect for auto-fire and return a
   * promise that resolves when the timer expires or the user cancels.
   * The pending state drives the cancel banner; the timer's resolution
   * value tells the caller whether to actually fire the redirect.
   */
  const scheduleAutoFireRedirect = (
    messageId: string,
    agentName: string,
    instruction: string,
  ): Promise<'fire' | 'cancel'> =>
    new Promise<'fire' | 'cancel'>((resolve) => {
      const firesAt = Date.now() + AUTO_REDIRECT_DELAY_MS;
      let resolved = false;
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        setPendingRedirect(null);
        resolve('fire');
      }, AUTO_REDIRECT_DELAY_MS);
      const cancel = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        setPendingRedirect(null);
        resolve('cancel');
      };
      setPendingRedirect({
        messageId,
        agentName,
        instruction,
        firesAt,
        cancel,
      });
    });

  // Auto mode used to spawn plans the moment they landed. That meant a
  // 6-agent plan you didn't expect could already be three agents deep
  // before you finished reading it. Now plans always wait for an explicit
  // confirm (with optional inline edits) from the PlanCard. The auto-mode
  // bit still controls downstream orchestration — Director-issued
  // redirects fire automatically here, and once you click Spawn the
  // backend sequences the agents itself.
  // M10: when mode flips manual → auto, mark every redirect that
  // already existed as handled BEFORE the auto-fire effect runs.
  // Without this, flipping to auto burst-fires every pending
  // redirect at once with no user warning. The user opted into
  // auto for *future* turns; the manual-mode backlog should stay
  // manual.
  const prevModeRef = useRef(mode);
  useEffect(() => {
    if (prevModeRef.current !== 'auto' && mode === 'auto') {
      for (const msg of messages) {
        if (msg.redirect && !msg.redirectFired) {
          handledRedirects.current.add(msg.id);
        }
      }
    }
    prevModeRef.current = mode;
  }, [mode, messages]);

  // R-Vuln6-2026-05-28: auto-fire is now staged — every effect run
  // enqueues new redirects (deduped via handledRedirects), and a
  // single async processor consumes the queue one item at a time
  // with a visible cancel window. The processor reads the queue
  // and refs (activeProjectIdRef, agentsRef) freshly inside the
  // loop so late-arriving redirects and agent state updates are
  // visible without restarting the loop.
  useEffect(() => {
    if (mode !== 'auto' || !activeProjectId) return;
    // Enqueue any newly-arrived unhandled redirects. Capture the
    // current projectId so an ack lands on the originating project
    // even if the user switches away during the cancel window.
    for (const msg of messages) {
      if (
        msg.redirect &&
        !msg.redirectFired &&
        !handledRedirects.current.has(msg.id)
      ) {
        handledRedirects.current.add(msg.id);
        redirectQueue.current.push({
          messageId: msg.id,
          agentName: msg.redirect.agent,
          instruction: msg.redirect.instruction,
          projectId: activeProjectId,
        });
      }
    }
    if (redirectQueue.current.length === 0) return;
    if (redirectProcessorRunning.current) return;
    redirectProcessorRunning.current = true;
    void (async () => {
      try {
        while (redirectQueue.current.length > 0) {
          const item = redirectQueue.current.shift();
          if (!item) break;
          const verdict = await scheduleAutoFireRedirect(
            item.messageId,
            item.agentName,
            item.instruction,
          );
          if (verdict === 'fire') {
            await fireRedirect(
              item.messageId,
              item.agentName,
              item.instruction,
              item.projectId,
            );
          } else {
            // User cancelled — ack as failed so the audit trail in
            // the chat shows the redirect was intentionally skipped.
            await window.api.ackDirectorRedirect({
              projectId: item.projectId,
              messageId: item.messageId,
              agentName: item.agentName,
              ok: false,
              error: 'cancelled by user',
            });
          }
        }
      } finally {
        redirectProcessorRunning.current = false;
      }
    })();
  }, [messages, mode, activeProjectId]);

  // F1: shared action handler for both the Director-composer slash menu
  // and the global Ctrl-K palette. Adding a new BuiltinAction to
  // shared/builtinCommands.ts + a case here lights it up in both
  // surfaces with no other changes.
  const runBuiltinAction = useCallback(
    async (action: BuiltinAction) => {
      switch (action) {
        case 'wipe-director':
          if (activeProjectId)
            await window.api.wipeDirector(activeProjectId);
          break;
        case 'open-usage':
          await window.api.openClaudeUsage();
          break;
        case 'go-agents':
          setActive('agents');
          break;
        case 'go-history':
          setActive('history');
          break;
        case 'go-settings':
          setActive('settings');
          break;
        case 'go-tools':
          setActive('tools');
          break;
        case 'go-templates':
          setActive('templates');
          break;
        case 'go-marketplace':
          setActive('marketplace');
          break;
        case 'go-docs':
          setActive('docs');
          break;
        case 'show-help':
          // Handled locally inside the Composer (opens modal). The
          // palette doesn't need a separate help affordance because
          // it IS the surfaced list.
          break;
      }
    },
    [activeProjectId, setActive],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing =
        tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable;
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        setSpawning(true);
      } else if (e.key === 'k' || e.key === 'K') {
        // F1: Ctrl/⌘-K opens the command palette. Fires even while
        // typing in an input — the palette is the global way to
        // navigate, so users shouldn't have to leave the composer to
        // get to it.
        e.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (e.key === '.' && !typing) {
        e.preventDefault();
        if (selectedId) void window.api.abortAgent(selectedId);
      } else if ((e.key === 'b' || e.key === 'B') && !typing) {
        e.preventDefault();
        setDrawerCollapsed(!drawerCollapsed);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, drawerCollapsed, setDrawerCollapsed]);

  const isHome = active === 'agents';

  return (
    <div className="app">
      <TopBar
        workspace={workspace}
        model={settings?.defaultModel ?? 'claude-sonnet-4-6'}
        viewMode={viewMode}
        onChangeWorkspace={async () => {
          if (!activeProjectId) return;
          const { path } = await window.api.pickWorkspace();
          if (path) await setProjectWorkspace(activeProjectId, path);
        }}
        onViewModeChange={setViewMode}
      />
      <ProjectTabs
        projects={projects}
        activeId={activeProjectId}
        agentCountByProject={agentCountByProject}
        onSelect={(id) => void setActiveProject(id)}
        onNewProject={() => setShowNewProject(true)}
        onDelete={(id) => setConfirmDeleteId(id)}
      />
      <div className="body">
        <LeftRail
          active={active}
          agentCount={agents.length}
          marketplaceUpdateCount={marketplace.pendingUpdates.length}
          onSelect={setActive}
        />

        {isHome && activeProjectId ? (
          <>
            <DirectorPane
              width={dirW}
              messages={messages}
              agents={agents}
              busy={busy}
              mode={mode}
              model={directorModel}
              effort={directorEffort}
              directorProvider={directorProvider}
              projectProvider={activeProvider}
              onModeChange={setMode}
              onModelChange={(m) => {
                if (activeProjectId) void setProjectDirectorModel(activeProjectId, m);
              }}
              onEffortChange={(e) => {
                if (activeProjectId) void setProjectDirectorEffort(activeProjectId, e);
              }}
              onDirectorProviderChange={(p) => {
                if (!activeProjectId) return;
                // null = clear override → fall back to project default.
                void setProjectDirectorProvider(
                  activeProjectId,
                  p === activeProvider ? null : p,
                );
              }}
              autoBranch={activeProject?.autoBranch === true}
              onAutoBranchChange={(next) => {
                if (!activeProjectId) return;
                void setProjectAutoBranch(activeProjectId, next);
              }}
              onSend={send}
              onSpawnPlan={spawnPlan}
              onSaveAsTemplate={(rows) => setSaveTemplateRows(rows)}
              onWipe={async () => {
                if (activeProjectId)
                  await window.api.wipeDirector(activeProjectId);
              }}
              onRewindTo={async (messageId) => {
                if (!activeProjectId) return;
                // F5: confirm before nuking. Truncated count is in
                // the IPC response — surface it post-confirm so the
                // user knows roughly what they wiped.
                if (
                  !window.confirm(
                    'Rewind the Director chat to this message?\n\n' +
                      'Every message after this point will be deleted from ' +
                      'the conversation and the next turn will start a fresh ' +
                      'session (no past memory). This cannot be undone.',
                  )
                ) {
                  return;
                }
                const r = await window.api.rewindDirector(
                  activeProjectId,
                  messageId,
                );
                if (r.ok) {
                  await refreshDirector();
                }
              }}
              viewMode={viewMode}
              projectId={activeProjectId}
              onSlashAction={runBuiltinAction}
            />
            <ResizeHandle
              value={dirW}
              onChange={setDirW}
              min={300}
              max={640}
              edge="left"
            />
            {viewMode === 'canvas' ? (
              <CanvasView
                agents={agents}
                selectedId={selectedId}
                onSelectAgent={setSelectedId}
                projectId={activeProjectId}
                workspace={workspace}
                defaultModel={spawnDefaultModel}
                defaultEffort={spawnDefaultEffort}
                provider={activeProject?.provider ?? 'claude'}
                spawning={spawning}
                setSpawning={setSpawning}
                onboardingBanner={
                  onboardingNeeded
                    ? {
                        busy: onboardingBusy,
                        onRun: () => void runOnboarding(),
                        onSkip: skipOnboarding,
                      }
                    : undefined
                }
              />
            ) : (
              <AgentsPane
                agents={agents}
                selectedId={selectedId}
                expanded={expanded}
                workspace={workspace}
                projectId={activeProjectId}
                defaultModel={spawnDefaultModel}
                defaultEffort={spawnDefaultEffort}
                spawning={spawning}
                viewMode={viewMode}
                provider={activeProject?.provider ?? 'claude'}
                onboardingBanner={
                  onboardingNeeded
                    ? {
                        busy: onboardingBusy,
                        onRun: () => void runOnboarding(),
                        onSkip: skipOnboarding,
                      }
                    : undefined
                }
                setSpawning={setSpawning}
                onSelect={setSelectedId}
                onToggle={toggle}
              />
            )}
            {!drawerCollapsed && (
              <ResizeHandle
                value={drawerW}
                onChange={setDrawerW}
                min={340}
                max={680}
                edge="right"
              />
            )}
            <Drawer
              width={drawerW}
              agent={selectedAgent}
              collapsed={drawerCollapsed}
              provider={activeProject?.provider ?? 'claude'}
              onAbort={(id) => void window.api.abortAgent(id)}
              onToggleCollapsed={() => setDrawerCollapsed(!drawerCollapsed)}
            />
          </>
        ) : active === 'settings' ? (
          <SettingsScreen />
        ) : active === 'tools' ? (
          <ToolsScreen
            project={activeProject}
            onChange={async (roleTools) => {
              if (activeProjectId)
                await setProjectRoleTools(activeProjectId, roleTools);
            }}
            onMcpChange={async (config) => {
              if (!activeProjectId)
                return { ok: false, error: 'no active project' };
              return setMcpConfig(activeProjectId, config);
            }}
          />
        ) : active === 'marketplace' ? (
          <MarketplaceScreen
            projectId={activeProjectId}
            projectName={activeProject?.name ?? null}
            projectProvider={activeProject?.provider ?? null}
            directorProvider={activeProject ? directorProvider : null}
          />
        ) : active === 'history' ? (
          <HistoryScreen
            projects={projects}
            onOpenAgent={async (projectId, agentId) => {
              if (projectId !== activeProjectId) {
                await setActiveProject(projectId);
              }
              setSelectedId(agentId);
              setActive('agents');
            }}
          />
        ) : active === 'templates' ? (
          <TemplatesScreen
            projectId={activeProjectId}
            onTemplateUsed={() => setActive('agents')}
          />
        ) : active === 'docs' ? (
          <DocsScreen activeProject={activeProject} />
        ) : (
          <PlaceholderScreen
            {...(active === 'agents'
              ? {
                  title: 'No project',
                  icon: 'agents' as const,
                  body: 'Create or select a project to get started.',
                }
              : PLACEHOLDERS[active])}
          />
        )}
      </div>
      <StatusBar agentCount={agents.length} />

      {marketplaceToast && (
        <button
          className="marketplace-toast"
          onClick={() => {
            setMarketplaceToast(null);
            setActive('marketplace');
          }}
          title="Click to open the Marketplace"
        >
          {marketplaceToast.count === 1
            ? '1 new bundle update available'
            : `${marketplaceToast.count} new bundle updates available`}{' '}
          · Marketplace
        </button>
      )}

      {showNewProject && (
        <NewProjectForm
          onCreate={async (name, ws, provider) => {
            const p = await createProject(name, ws, provider);
            await setActiveProject(p.id);
            setShowNewProject(false);
          }}
          onCancel={() => setShowNewProject(false)}
        />
      )}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onRun={runBuiltinAction}
      />
      {pendingRedirect && (
        <PendingRedirectBanner
          agentName={pendingRedirect.agentName}
          instruction={pendingRedirect.instruction}
          firesAt={pendingRedirect.firesAt}
          onCancel={pendingRedirect.cancel}
        />
      )}
      {basePrompt && (
        <BaseBranchModal
          branches={basePrompt.branches}
          current={basePrompt.current}
          onResolve={basePrompt.resolve}
        />
      )}
      {saveTemplateRows && (
        <SaveTemplateDialog
          rows={saveTemplateRows}
          mode={mode}
          onCancel={() => setSaveTemplateRows(null)}
          onSave={async (input) => {
            const created = await window.api.createTemplate({
              name: input.name,
              description: input.description,
              mode: input.mode,
              tags: input.tags,
              rows: saveTemplateRows,
            });
            setSaveTemplateRows(null);
            return created;
          }}
        />
      )}
      {confirmDeleteId &&
        (() => {
          const target = projects.find((p) => p.id === confirmDeleteId);
          if (!target) return null;
          return (
            <ConfirmDeleteProject
              project={target}
              onConfirm={async () => {
                // If deleting the active project, switch to another one first
                // so the UI doesn't briefly render an orphan state.
                if (confirmDeleteId === activeProjectId) {
                  const fallback = projects.find(
                    (p) => p.id !== confirmDeleteId,
                  );
                  if (fallback) await setActiveProject(fallback.id);
                }
                await removeProject(confirmDeleteId);
                setConfirmDeleteId(null);
              }}
              onCancel={() => setConfirmDeleteId(null)}
            />
          );
        })()}
      {cliStatus && !cliStatus[activeProvider] && (
        <CliMissingGate
          provider={activeProvider}
          onResolved={() =>
            setCliStatus((prev) =>
              prev ? { ...prev, [activeProvider]: true } : prev,
            )
          }
        />
      )}
    </div>
  );
}
