import { useState } from 'react';
import type { Agent, AgentRole } from '../../shared/types';
import { ROLES } from '../../shared/roles';
import { Icon } from './Icon';
import { LogLineRow } from './LogLineRow';
import { ModelPicker } from './ModelPicker';

const ROLE_TINT: Record<AgentRole, string> = {
  pm: '#4ade80',
  researcher: '#60a5fa',
  coder: '#c084fc',
  qa: '#fbbf24',
  devops: '#f97316',
};

const CONTEXT_CAP = 200_000;

type TabId = 'logs' | 'tools' | 'memory' | 'context' | 'config';

interface Props {
  width: number;
  agent: Agent | null;
  onAbort: (id: string) => void;
}

export function Drawer({ width, agent, onAbort }: Props) {
  const [tab, setTab] = useState<TabId>('logs');

  if (!agent) {
    return (
      <div className="drawer" style={{ width }}>
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
      <Header agent={agent} onAbort={() => onAbort(agent.id)} />

      <div className="tabs">
        <TabHead id="logs" label="Logs" count={agent.log.length} active={tab} onSelect={setTab} />
        <TabHead id="tools" label="Tools" count={toolCount} active={tab} onSelect={setTab} />
        <TabHead id="memory" label="Memory" count={0} active={tab} onSelect={setTab} />
        <TabHead id="context" label="Context" active={tab} onSelect={setTab} />
        <TabHead id="config" label="Config" active={tab} onSelect={setTab} />
      </div>

      <div className="drawer-body">
        {tab === 'logs' && <LogsTab agent={agent} />}
        {tab === 'tools' && <ToolsTab agent={agent} />}
        {tab === 'memory' && <MemoryTab />}
        {tab === 'context' && <ContextTab agent={agent} />}
        {tab === 'config' && <ConfigTab agent={agent} />}
      </div>
    </div>
  );
}

function Header({ agent, onAbort }: { agent: Agent; onAbort: () => void }) {
  const isRunning = agent.status === 'running' || agent.status === 'waiting';
  const canRedirect = !isRunning && !!agent.sessionId;
  const [redirectOpen, setRedirectOpen] = useState(false);

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
        <Kpi label="Tokens" value={`${(agent.tokens / 1000).toFixed(1)}k`} />
        <Kpi label="Cost" value={`$${agent.cost.toFixed(2)}`} />
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
          disabled
          title="Fork via SDK forkSession() — wiring up in a follow-up"
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
          onClose={() => setRedirectOpen(false)}
        />
      )}
    </div>
  );
}

function RedirectForm({
  agentId,
  currentModel,
  onClose,
}: {
  agentId: string;
  currentModel: string;
  onClose: () => void;
}) {
  const [body, setBody] = useState('');
  const [model, setModel] = useState(currentModel);
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
        <ModelPicker value={model} onChange={setModel} compact />
      </div>
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
  return (
    <div
      className={'tab' + (active === id ? ' active' : '')}
      onClick={() => onSelect(id)}
    >
      {label}
      {count != null && <span className="count">{count}</span>}
    </div>
  );
}

function LogsTab({ agent }: { agent: Agent }) {
  const tail = agent.log.slice(-8);
  return (
    <>
      <div className="field">
        <span className="lbl">Current task</span>
        <span className="v">{agent.task}</span>
      </div>
      <div className="field">
        <span className="lbl">Spawned by</span>
        <span className="v">
          {agent.spawnedBy === 'director'
            ? 'director · auto-spawned from plan'
            : 'you · manual spawn'}
        </span>
      </div>
      <div className="field">
        <span className="lbl">Last {tail.length} log lines</span>
        {tail.length > 0 ? (
          <div
            className="agent-log"
            style={{
              padding: 8,
              background: 'var(--sub)',
              border: '1px solid var(--border)',
              borderRadius: 6,
            }}
          >
            {tail.map((l, i) => (
              <LogLineRow key={i} line={l} />
            ))}
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

function MemoryTab() {
  return (
    <div className="inline-empty">
      Memory pins land in M5 (via the SDK's memory tool). For now an agent's
      working notes live only in its log.
    </div>
  );
}

function ContextTab({ agent }: { agent: Agent }) {
  const used = agent.tokens;
  const pct = Math.min(100, Math.round((used / CONTEXT_CAP) * 100));
  return (
    <>
      <div className="field">
        <span className="lbl">
          Context window · {(used / 1000).toFixed(1)}k / {CONTEXT_CAP / 1000}k ·{' '}
          {pct}%
        </span>
        <div className="ctx-bar">
          <div
            className="ctx-seg"
            style={{ width: `${pct}%`, background: 'var(--accent)' }}
          />
        </div>
      </div>
      <div className="inline-empty">
        Per-segment breakdown (System / Tools / Files / History / Memory)
        lands when we plumb model-side usage telemetry. For v1 the totals come
        from <code>result</code> events.
      </div>
    </>
  );
}

function ConfigTab({ agent }: { agent: Agent }) {
  const [expanded, setExpanded] = useState(false);
  const role = ROLES[agent.role];
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
          <code>{agent.model}</code>
        </span>
      </div>
      <div className="field">
        <span className="lbl">Workspace</span>
        <span className="v">
          <code>{agent.workspace}</code>
        </span>
      </div>
      <div className="field">
        <span className="lbl">Budget caps</span>
        <BudgetBars agent={agent} />
      </div>
    </>
  );
}

function BudgetBars({ agent }: { agent: Agent }) {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - agent.startedAt) / 1000),
  );
  return (
    <div className="budget-bars">
      <BudgetBar
        label="Cost"
        used={agent.cost}
        cap={agent.budget.usd}
        formatUsed={(v) => `$${v.toFixed(2)}`}
        formatCap={(v) => `$${v.toFixed(2)}`}
      />
      <BudgetBar
        label="Tokens"
        used={agent.tokens}
        cap={agent.budget.tokens}
        formatUsed={(v) => v.toLocaleString()}
        formatCap={(v) => v.toLocaleString()}
      />
      <BudgetBar
        label="Time"
        used={elapsedSeconds}
        cap={agent.budget.seconds}
        formatUsed={(v) => `${v}s`}
        formatCap={(v) => `${v}s`}
      />
    </div>
  );
}

function BudgetBar({
  label,
  used,
  cap,
  formatUsed,
  formatCap,
}: {
  label: string;
  used: number;
  cap: number;
  formatUsed: (v: number) => string;
  formatCap: (v: number) => string;
}) {
  if (cap <= 0) {
    return (
      <div className="budget-bar">
        <span className="b-lbl">{label}</span>
        <div className="b-track">
          <div className="b-fill" style={{ width: '0%' }} />
        </div>
        <span className="b-val">{formatUsed(used)} / ∞</span>
      </div>
    );
  }
  const pct = Math.min(100, Math.max(0, (used / cap) * 100));
  const cls = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '';
  return (
    <div className="budget-bar">
      <span className="b-lbl">{label}</span>
      <div className="b-track">
        <div
          className={'b-fill' + (cls ? ' ' + cls : '')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="b-val">
        {formatUsed(used)} / {formatCap(cap)}
      </span>
    </div>
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
