import { useEffect, useRef, useState } from 'react';
import type {
  Agent,
  EffortLevel,
  MemoryProposal,
  Provider,
} from '../../shared/types';
import { ROLES, ROLE_TINT } from '../../shared/roles';
import { Icon } from './Icon';
import { LogLineRow } from './LogLineRow';
import { ModelPicker } from './ModelPicker';
import { EffortPicker } from './EffortPicker';
import { computeLogLineKey } from '../../shared/logNotes';
import { useLogNotes } from '../hooks/useLogNotes';

type TabId = 'logs' | 'tools' | 'memory' | 'config';

const COLLAPSED_WIDTH = 36;

interface Props {
  width: number;
  agent: Agent | null;
  collapsed: boolean;
  provider: Provider;
  onAbort: (id: string) => void;
  onToggleCollapsed: () => void;
}

export function Drawer({
  width,
  agent,
  collapsed,
  provider,
  onAbort,
  onToggleCollapsed,
}: Props) {
  const [tab, setTab] = useState<TabId>('logs');
  // Must run before any early return below (hooks-order rule).
  // Passes through to a no-op count when `agent` is undefined.
  const memoryCount = usePendingMemoryCount(agent);

  // Collapsed: thin vertical strip with an expand button. Stays present
  // (rather than disappearing entirely) so the affordance to bring the
  // drawer back is always visible, and the expand state survives the
  // user clicking around different agents.
  if (collapsed) {
    return (
      <div className="drawer drawer-collapsed" style={{ width: COLLAPSED_WIDTH }}>
        <button
          className="drawer-collapse-btn"
          onClick={onToggleCollapsed}
          title="Expand inspector"
        >
          <Icon name="chevron" size={11} />
        </button>
        {agent && (
          <span className="drawer-collapsed-name" title={`${agent.name} selected`}>
            {agent.name}
          </span>
        )}
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="drawer" style={{ width }}>
        <DrawerCollapseBar onToggle={onToggleCollapsed} />
        <div className="empty" style={{ height: '100%' }}>
          <div className="empty-glyph">
            <Icon name="agents" size={24} color="var(--muted)" stroke={1.2} />
          </div>
          <div className="empty-title" style={{ color: 'var(--text-2)' }}>
            No agent selected
          </div>
          <div className="empty-body">
            Click any agent in the workspace to inspect its tools, memory,
            context, and live log. Hit <code>⌘1</code>–<code>⌘9</code> to jump.
          </div>
        </div>
      </div>
    );
  }

  const toolCount = countUsedTools(agent);

  return (
    <div className="drawer" style={{ width }}>
      <DrawerCollapseBar onToggle={onToggleCollapsed} />
      <Header agent={agent} provider={provider} onAbort={() => onAbort(agent.id)} />

      {/* H11: tablist + arrow-key nav per the MarketplaceScreen
          pattern. Previously these were <div onClick> with no
          keyboard handling and no role/aria-selected for AT users. */}
      <div
        className="tabs"
        role="tablist"
        onKeyDown={(e) => {
          const tabIds: TabId[] = ['logs', 'tools', 'memory', 'config'];
          const idx = tabIds.indexOf(tab);
          if (e.key === 'ArrowRight') {
            e.preventDefault();
            setTab(tabIds[(idx + 1) % tabIds.length]);
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            setTab(tabIds[(idx - 1 + tabIds.length) % tabIds.length]);
          } else if (e.key === 'Home') {
            e.preventDefault();
            setTab(tabIds[0]);
          } else if (e.key === 'End') {
            e.preventDefault();
            setTab(tabIds[tabIds.length - 1]);
          }
        }}
      >
        <TabHead id="logs" label="Logs" count={agent.log.length} active={tab} onSelect={setTab} />
        <TabHead id="tools" label="Tools" count={toolCount} active={tab} onSelect={setTab} />
        <TabHead id="memory" label="Memory" count={memoryCount} active={tab} onSelect={setTab} />
        <TabHead id="config" label="Config" active={tab} onSelect={setTab} />
      </div>

      <div className="drawer-body">
        {tab === 'logs' && <LogsTab agent={agent} />}
        {tab === 'tools' && <ToolsTab agent={agent} />}
        {tab === 'memory' && <MemoryTab agent={agent} />}
        {tab === 'config' && <ConfigTab agent={agent} provider={provider} />}
      </div>
    </div>
  );
}

function DrawerCollapseBar({ onToggle }: { onToggle: () => void }) {
  return (
    <div className="drawer-collapse-bar">
      <button
        className="drawer-collapse-btn"
        onClick={onToggle}
        title="Collapse inspector"
      >
        <Icon name="chevron-down" size={11} />
      </button>
    </div>
  );
}

function Header({
  agent,
  provider,
  onAbort,
}: {
  agent: Agent;
  provider: Provider;
  onAbort: () => void;
}) {
  const isRunning = agent.status === 'running' || agent.status === 'waiting';
  const canRedirect = !isRunning && !!agent.sessionId;
  // Provider checks below run against the agent's own provider, not the
  // project's, so a codex-overridden agent on a claude project is gated
  // correctly (and vice versa).
  const effectiveProvider = agent.provider ?? provider;
  // Fork can happen any time the parent has produced a session id — even
  // mid-flight. The fork is a separate session and doesn't disturb the
  // parent's run, so we don't gate on isRunning. Codex's `fork` is a
  // TUI-only subcommand (no --json / no -p), so we can't drive it from
  // a subprocess — fork stays disabled for codex agents until either
  // codex adds a non-interactive fork or we build one ourselves on top
  // of `codex exec resume`.
  const canFork = !!agent.sessionId && effectiveProvider !== 'codex';
  const [redirectOpen, setRedirectOpen] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);

  return (
    <div className="drawer-head">
      <div className="drawer-id">
        <div className="sigil" style={{ color: ROLE_TINT[agent.role] }}>
          <Icon name="agents" size={16} color={ROLE_TINT[agent.role]} />
        </div>
        <div className="who">
          <span className="name">{agent.name}</span>
          <span className="meta">
            {agent.roleLabel} · {agent.model}
          </span>
        </div>
        <span className="spacer" />
        <span className={'pill ' + agent.status}>{agent.statusLabel}</span>
      </div>

      <div className="drawer-kpis">
        <Kpi label="Step" value={agent.step} />
        <Kpi label="Elapsed" value={agent.elapsed} />
      </div>

      <div className="drawer-actions">
        <button
          className="tb-btn"
          disabled={!isRunning}
          onClick={onAbort}
          title={isRunning ? 'Abort the agent' : 'Not running'}
        >
          <Icon name="stop" size={11} /> Pause
        </button>
        <button
          className="tb-btn"
          disabled={!canRedirect}
          onClick={() => setRedirectOpen((v) => !v)}
          title={
            isRunning
              ? 'Abort the agent first'
              : !agent.sessionId
              ? 'No session captured yet (no result event)'
              : 'Continue this agent with a new instruction'
          }
        >
          <Icon name="redirect" size={11} /> Redirect
        </button>
        <button
          className="tb-btn"
          disabled={!canFork}
          onClick={() => setForkOpen((v) => !v)}
          title={
            effectiveProvider === 'codex'
              ? "Fork isn't available on codex agents — `codex fork` is a TUI-only subcommand with no --json output, so we can't drive it from a subprocess yet."
              : !agent.sessionId
              ? 'No session captured yet (no result event)'
              : 'Branch a new agent off this one — parent stays intact'
          }
        >
          <Icon name="fork" size={11} /> Fork
        </button>
        <button
          className="tb-btn primary"
          disabled
          title="Approval gates — deferred"
        >
          <Icon name="check" size={11} /> Approve
        </button>
      </div>

      {redirectOpen && (
        <RedirectForm
          agentId={agent.id}
          currentModel={agent.model}
          currentEffort={agent.effort}
          provider={effectiveProvider}
          onClose={() => setRedirectOpen(false)}
        />
      )}
      {forkOpen && (
        <ForkForm
          parentAgentId={agent.id}
          currentModel={agent.model}
          currentEffort={agent.effort}
          provider={effectiveProvider}
          onClose={() => setForkOpen(false)}
        />
      )}
    </div>
  );
}

function ForkForm({
  parentAgentId,
  currentModel,
  currentEffort,
  provider,
  onClose,
}: {
  parentAgentId: string;
  currentModel: string;
  currentEffort: EffortLevel;
  provider: Provider;
  onClose: () => void;
}) {
  const [task, setTask] = useState('');
  const [model, setModel] = useState(currentModel);
  const [effort, setEffort] = useState<EffortLevel>(currentEffort);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = task.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.api.forkAgent({
        parentAgentId,
        task: trimmed,
        ...(model !== currentModel ? { model } : {}),
        ...(effort !== currentEffort ? { effort } : {}),
      });
      if (!res.ok) {
        setError(res.error ?? 'fork failed');
        return;
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="redirect-form">
      <div className="redirect-model-row">
        <span className="lbl">Model</span>
        <ModelPicker
          value={model}
          onChange={setModel}
          compact
          provider={provider}
        />
      </div>
      {provider === 'claude' && (
        <div className="redirect-model-row">
          <span className="lbl">Effort</span>
          <EffortPicker value={effort} onChange={setEffort} compact />
        </div>
      )}
      <textarea
        className="text-input task-input"
        value={task}
        onChange={(e) => setTask(e.target.value)}
        placeholder="New direction for the forked agent — it starts with the parent's full chat history."
        rows={3}
        autoFocus
      />
      {error && <div className="form-error">{error}</div>}
      <div className="redirect-form-bar">
        <button className="tb-btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          className="tb-btn primary"
          onClick={() => void submit()}
          disabled={busy || !task.trim()}
        >
          <Icon name="fork" size={11} /> {busy ? 'Forking…' : 'Fork'}
        </button>
      </div>
    </div>
  );
}

function RedirectForm({
  agentId,
  currentModel,
  currentEffort,
  provider,
  onClose,
}: {
  agentId: string;
  currentModel: string;
  currentEffort: EffortLevel;
  provider: Provider;
  onClose: () => void;
}) {
  const [body, setBody] = useState('');
  const [model, setModel] = useState(currentModel);
  const [effort, setEffort] = useState<EffortLevel>(currentEffort);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.api.redirectAgent({
        agentId,
        body: trimmed,
        ...(model !== currentModel ? { model } : {}),
        ...(effort !== currentEffort ? { effort } : {}),
      });
      if (!res.ok) {
        setError(res.error ?? 'redirect failed');
        return;
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="redirect-form">
      <div className="redirect-model-row">
        <span className="lbl">Model</span>
        <ModelPicker
          value={model}
          onChange={setModel}
          compact
          provider={provider}
        />
      </div>
      {provider === 'claude' && (
        <div className="redirect-model-row">
          <span className="lbl">Effort</span>
          <EffortPicker value={effort} onChange={setEffort} compact />
        </div>
      )}
      <textarea
        className="text-input task-input"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="New instruction to continue this agent with…"
        rows={3}
        autoFocus
      />
      {error && <div className="form-error">{error}</div>}
      <div className="redirect-form-bar">
        <button className="tb-btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          className="tb-btn primary"
          onClick={() => void submit()}
          disabled={busy || !body.trim()}
        >
          <Icon name="redirect" size={11} /> {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="val">{value}</div>
    </div>
  );
}

function TabHead({
  id,
  label,
  count,
  active,
  onSelect,
}: {
  id: TabId;
  label: string;
  count?: number;
  active: TabId;
  onSelect: (id: TabId) => void;
}) {
  const isActive = active === id;
  return (
    <button
      type="button"
      className={'tab' + (isActive ? ' active' : '')}
      onClick={() => onSelect(id)}
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
    >
      {label}
      {count != null && <span className="count">{count}</span>}
    </button>
  );
}

function LogsTab({ agent }: { agent: Agent }) {
  const lines = agent.log;
  // F12: pinned notes for this agent's log lines. The drawer is the
  // place users park to read + annotate, so the hook lives here
  // (rather than at the AgentRow level where notes wouldn't
  // typically be authored from the rail).
  const { notes, setNote } = useLogNotes(agent.id);
  // QOL-1: the FULL run log, scrollable, newest at the bottom (the inspector
  // used to show only the last 8 lines after the full-stream pane was deleted
  // in the Flightdeck redesign). Stick to the bottom while a live agent streams,
  // but pause auto-scroll if the user scrolls up to read — mirrors the Director
  // stream. Capped at LOG_TAIL_CAP (2000) in main; LogLineRow is memoized, so a
  // plain render is fine until/unless that cap actually lags (then: virtualize).
  const logRef = useRef<HTMLDivElement | null>(null);
  const [stick, setStick] = useState(true);
  const onLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };
  useEffect(() => {
    if (!stick) return;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, stick]);
  return (
    <>
      <div className="field">
        <span className="lbl">Current task</span>
        <span className="v">{agent.task}</span>
      </div>
      <div className="field">
        <span className="lbl">Spawned by</span>
        <span className="v">
          {agent.forkedFromName
            ? `fork of @${agent.forkedFromName}`
            : agent.spawnedBy === 'director'
            ? 'director · auto-spawned from plan'
            : 'you · manual spawn'}
        </span>
      </div>
      <div className="field">
        <span className="lbl">
          Log{lines.length > 0 ? ` · ${lines.length} line${lines.length === 1 ? '' : 's'}` : ''}
        </span>
        {lines.length > 0 ? (
          <div
            ref={logRef}
            className="agent-log"
            onScroll={onLogScroll}
            style={{
              padding: 8,
              background: 'var(--sub)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              maxHeight: '52vh',
              overflowY: 'auto',
            }}
          >
            {lines.map((l, i) => {
              const lineKey = computeLogLineKey(l);
              return (
                // M11: composite key — see AgentRow for rationale.
                <LogLineRow
                  key={`${l.ts}-${l.kind}-${i}`}
                  line={l}
                  note={notes.get(lineKey)}
                  onSaveNote={setNote}
                />
              );
            })}
          </div>
        ) : (
          <div className="inline-empty">No log entries yet.</div>
        )}
      </div>
    </>
  );
}

function ToolsTab({ agent }: { agent: Agent }) {
  const role = ROLES[agent.role];
  const usage = new Map<string, { count: number; lastTs: string }>();
  for (const line of agent.log) {
    if (line.kind === 'tool' && typeof line.msg === 'object') {
      const fn = line.msg.fn;
      const prev = usage.get(fn);
      usage.set(fn, { count: (prev?.count ?? 0) + 1, lastTs: line.ts });
    }
  }
  const seen = new Set<string>();
  const ordered = [...role.tools, ...usage.keys()].filter((name) => {
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });

  return (
    <>
      <div className="field">
        <span className="lbl">Granted toolset</span>
      </div>
      {ordered.length === 0 ? (
        <div className="inline-empty">No tools granted to this agent.</div>
      ) : (
        ordered.map((name) => {
          const info = usage.get(name);
          return (
            <div className="tool-row" key={name}>
              <span className="ic">
                <Icon name="tools" size={12} color="var(--accent)" />
              </span>
              <span className="name">
                <span className="ns">{namespaceFor(name)}.</span>
                {name}
              </span>
              <span className="count">{info?.count ?? 0}×</span>
              <span className="lastuse">
                {info ? info.lastTs.slice(0, 8) : '—'}
              </span>
            </div>
          );
        })
      )}
    </>
  );
}

function MemoryTab({ agent }: { agent: Agent }) {
  const [pending, setPending] = useState<MemoryProposal[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    void window.api
      .listMemoryProposals(agent.projectId, agent.role, 'pending')
      .then(setPending);
  };

  useEffect(() => {
    refresh();
    const off = window.api.onMemoryProposal((p) => {
      if (p.projectId !== agent.projectId || p.role !== agent.role) return;
      if (p.status !== 'pending') return;
      setPending((prev) => [p, ...prev.filter((x) => x.id !== p.id)]);
    });
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.projectId, agent.role]);

  const decide = async (id: string, approve: boolean) => {
    setBusy((b) => ({ ...b, [id]: true }));
    setError(null);
    const result = approve
      ? await window.api.approveMemoryProposal(id)
      : await window.api.rejectMemoryProposal(id);
    setBusy((b) => {
      const next = { ...b };
      delete next[id];
      return next;
    });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPending((prev) => prev.filter((p) => p.id !== id));
  };

  if (pending.length === 0 && !error) {
    return (
      <div className="inline-empty">
        No pending memory proposals for the <code>{agent.role}</code> role.
        Agents propose memory by emitting an{' '}
        <code>orchestrator-memory</code> fenced block; approved pins are
        appended to this project&apos;s per-role prompt and seen by every
        future spawn of this role.
      </div>
    );
  }

  return (
    <div className="memory-tab">
      {error && <div className="memory-error">{error}</div>}
      {pending.map((p) => (
        <div key={p.id} className="memory-proposal">
          <div className="memory-meta">
            <span className="memory-from">
              from{' '}
              <code>
                {p.sourceAgentName ?? p.sourceAgentId ?? 'unknown'}
              </code>
            </span>
            <span className="memory-ts">
              {new Date(p.createdAt).toLocaleString()}
            </span>
          </div>
          <pre className="memory-body">{p.body}</pre>
          <div className="memory-actions">
            <button
              className="tb-btn"
              onClick={() => void decide(p.id, false)}
              disabled={!!busy[p.id]}
              title="Discard this proposal; the per-role prompt is not changed."
            >
              <Icon name="x" size={11} /> Reject
            </button>
            <button
              className="tb-btn primary"
              onClick={() => void decide(p.id, true)}
              disabled={!!busy[p.id]}
              title="Append this body to the per-role prompt. Future spawns of this role will see it."
            >
              <Icon name="check" size={11} /> Approve
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ConfigTab({
  agent,
  provider,
}: {
  agent: Agent;
  provider: Provider;
}) {
  const [expanded, setExpanded] = useState(false);
  const role = ROLES[agent.role];
  // An agent's effective provider is its own override (set at spawn
  // time) or the project's default. The Model + Effort pickers below
  // must filter by the agent's provider, not the project's — a codex
  // agent on a claude project must show codex models.
  const effectiveProvider = agent.provider ?? provider;
  return (
    <>
      <div className="field">
        <span className="lbl">System prompt</span>
        <div
          className="sys-prompt"
          onClick={() => setExpanded((v) => !v)}
          style={{
            maxHeight: expanded ? 'none' : 110,
            cursor: 'pointer',
          }}
          title={expanded ? 'Click to collapse' : 'Click to expand'}
        >
          {role.systemPrompt}
        </div>
      </div>
      <div className="field">
        <span className="lbl">Model</span>
        <span className="v">
          <ModelPicker
            value={agent.model}
            compact
            provider={effectiveProvider}
            onChange={(m) => {
              if (m && m !== agent.model) void window.api.setAgentModel(agent.id, m);
            }}
          />
          {(agent.status === 'running' || agent.status === 'waiting') && (
            <div className="meta" style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>
              Active session keeps its current model. New value applies on next redirect.
            </div>
          )}
        </span>
      </div>
      {effectiveProvider === 'claude' && (
        <div className="field">
        <span className="lbl">Reasoning effort</span>
        <span className="v">
          <EffortPicker
            value={agent.effort}
            compact
            onChange={(e) => {
              if (e !== agent.effort) void window.api.setAgentEffort(agent.id, e);
            }}
          />
          {(agent.status === 'running' || agent.status === 'waiting') && (
            <div className="meta" style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>
              Active session keeps its current effort. New value applies on next redirect.
            </div>
          )}
        </span>
      </div>
      )}
      <div className="field">
        <span className="lbl">Provider</span>
        <span className="v">
          <code>{agent.provider ?? provider}</code>
          {agent.provider && agent.provider !== provider && (
            <span
              className="meta"
              style={{ marginLeft: 6, fontSize: 11, color: 'var(--muted)' }}
            >
              (project default is {provider})
            </span>
          )}
        </span>
      </div>
      <div className="field">
        <span className="lbl">Workspace</span>
        <span className="v">
          <code>{agent.workspace}</code>
        </span>
      </div>
    </>
  );
}

function countUsedTools(agent: Agent): number {
  const set = new Set<string>();
  for (const line of agent.log) {
    if (line.kind === 'tool' && typeof line.msg === 'object') {
      set.add(line.msg.fn);
    }
  }
  return set.size;
}

function namespaceFor(name: string): string {
  if (name === 'Bash') return 'sh';
  if (name === 'WebFetch' || name === 'WebSearch') return 'web';
  if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'Glob' || name === 'Grep') {
    return 'fs';
  }
  return 'tool';
}

/**
 * Tracks pending memory proposals for the agent's (project, role)
 * scope. Initial count comes from `listMemoryProposals`; subsequent
 * deltas come from the `onMemoryProposal` event so the Memory tab's
 * count badge stays live without polling.
 *
 * Accepts `undefined` so the Drawer can call it unconditionally
 * before its "no agent selected" early-return (hooks must run in
 * the same order on every render). When agent is undefined the
 * effect body skips the IPC subscription and the returned count
 * stays at 0.
 *
 * Approval/rejection happen inside `MemoryTab` and don't broadcast
 * a removal event; the tab handles its own UI state. The count
 * here will lag by one click — matches the same lag the other tab
 * counts have (they all derive from agent.log which isn't
 * decremented either).
 */
function usePendingMemoryCount(agent: Agent | null | undefined): number {
  const [count, setCount] = useState(0);
  const projectId = agent?.projectId;
  const role = agent?.role;
  useEffect(() => {
    if (!projectId || !role) {
      setCount(0);
      return;
    }
    let alive = true;
    void window.api
      .listMemoryProposals(projectId, role, 'pending')
      .then((list) => {
        if (alive) setCount(list.length);
      });
    const off = window.api.onMemoryProposal((p) => {
      if (
        p.projectId === projectId &&
        p.role === role &&
        p.status === 'pending'
      ) {
        setCount((c) => c + 1);
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [projectId, role]);
  return count;
}
