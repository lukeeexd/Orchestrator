import { useEffect, useMemo, useState } from 'react';
import type { AgentRole, Project } from '../../shared/types';
import { ROLES } from '../../shared/roles';
import { KNOWN_TOOLS } from '../../shared/tools';
import { Icon } from './Icon';
import { SkillsEditor } from './SkillsEditor';

interface Props {
  project: Project | null;
  onChange: (
    roleTools: Partial<Record<AgentRole, string[]>> | null,
  ) => Promise<void>;
  onMcpChange: (
    config: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
}

const ROLE_TINT: Record<AgentRole, string> = {
  pm: '#4ade80',
  researcher: '#60a5fa',
  coder: '#c084fc',
  qa: '#fbbf24',
  devops: '#f97316',
  security: '#f87171',
};

const ROLE_ORDER: AgentRole[] = ['pm', 'researcher', 'coder', 'qa', 'devops', 'security'];

export function ToolsScreen({ project, onChange, onMcpChange }: Props) {
  // Compose the live allow-list for every role: project override (if any)
  // wins over the role's hardcoded default. Same precedence the runner
  // uses at spawn time — keep them in lockstep.
  const liveTools = useMemo(() => {
    const out: Record<AgentRole, Set<string>> = {
      pm: new Set(),
      researcher: new Set(),
      coder: new Set(),
      qa: new Set(),
      devops: new Set(),
      security: new Set(),
    };
    for (const role of ROLE_ORDER) {
      const override = project?.roleTools?.[role];
      const list = override && override.length > 0 ? override : ROLES[role].tools;
      for (const t of list) out[role].add(t);
    }
    return out;
  }, [project]);

  const hasOverride = (role: AgentRole) => !!project?.roleTools?.[role];

  // Write a new allow-list for one role. We persist the entire roleTools
  // map each time so the main process can do a single UPDATE; we also
  // clear an override back to undefined if the new list matches the
  // role's default (round-trip clean).
  const setRoleAllowList = async (role: AgentRole, next: string[]) => {
    const defaults = ROLES[role].tools;
    const sameAsDefault =
      next.length === defaults.length && next.every((t) => defaults.includes(t));
    const merged: Partial<Record<AgentRole, string[]>> = {
      ...(project?.roleTools ?? {}),
    };
    if (sameAsDefault) {
      delete merged[role];
    } else {
      merged[role] = next;
    }
    await onChange(Object.keys(merged).length > 0 ? merged : null);
  };

  const toggle = (role: AgentRole, tool: string) => {
    const current = liveTools[role];
    const next = current.has(tool)
      ? [...current].filter((t) => t !== tool)
      : [...current, tool];
    // Preserve KNOWN_TOOLS order for stability — the saved list reads
    // top-to-bottom matching the grid.
    next.sort(
      (a, b) =>
        KNOWN_TOOLS.findIndex((t) => t.id === a) -
        KNOWN_TOOLS.findIndex((t) => t.id === b),
    );
    void setRoleAllowList(role, next);
  };

  const resetRole = (role: AgentRole) => {
    void setRoleAllowList(role, [...ROLES[role].tools]);
  };

  const [tab, setTab] = useState<'tools' | 'skills' | 'mcp'>('tools');

  if (!project) {
    return (
      <div className="pane" style={{ flex: 1 }}>
        <div className="pane-head">
          <span className="title">
            <b>Tools</b>
          </span>
        </div>
        <div className="empty" style={{ height: 'auto', padding: 32 }}>
          <div className="empty-title" style={{ color: 'var(--text-2)' }}>
            No project
          </div>
          <div className="empty-body">
            Tool allow-lists are stored per project. Create or select one to
            edit them.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pane settings-pane" style={{ flex: 1 }}>
      <div className="pane-head">
        <span className="title">
          <b>Roles</b>
        </span>
        <div
          className="mode-toggle"
          style={{ marginLeft: 12 }}
          title="Per-role configuration: tool allow-lists (claude only) or skill prompts (both providers)."
        >
          <button
            className={tab === 'tools' ? 'on' : ''}
            onClick={() => setTab('tools')}
          >
            tools
          </button>
          <button
            className={tab === 'skills' ? 'on' : ''}
            onClick={() => setTab('skills')}
          >
            skills
          </button>
          <button
            className={tab === 'mcp' ? 'on' : ''}
            onClick={() => setTab('mcp')}
          >
            mcp
          </button>
        </div>
        <span className="spacer" />
      </div>

      <div className="settings-body">
        {tab === 'mcp' ? (
          <McpEditor project={project} onMcpChange={onMcpChange} />
        ) : tab === 'skills' ? (
          <section className="settings-section">
            <h3 className="settings-h">Per-role skill prompts</h3>
            <p className="settings-help">
              Markdown appended to each role&apos;s system prompt at spawn
              time. Lets you teach a role about your codebase&apos;s
              conventions without editing the hardcoded prompts. Saved
              per-project at{' '}
              <code>{`<workspace>/.orchestrator/skills/<role>.md`}</code>.
              Empty file means &quot;no skill&quot; (overrides any in-app
              default).
            </p>
            <SkillsEditor project={project} />
          </section>
        ) : project.provider === 'codex' ? (
          <section className="settings-section">
            <h3 className="settings-h">Tool allow-lists</h3>
            <div className="inline-empty" style={{ padding: 18 }}>
              Not applicable for codex projects. Codex uses sandbox-policy
              scopes (<code>read-only</code>, <code>workspace-write</code>,{' '}
              <code>danger-full-access</code>) instead of named tool
              allow-lists. Per-role sandbox overrides aren&apos;t exposed
              yet — every codex agent currently runs with{' '}
              <code>workspace-write</code>. Switch to the{' '}
              <strong>skills</strong> tab to author per-role guidance that
              <em> does</em> apply on codex.
            </div>
          </section>
        ) : (
        <>
        <section className="settings-section">
          <h3 className="settings-h">Role × tool allow-lists</h3>
          <p className="settings-help">
            What each role is permitted to call in this project. Rows with
            edits show as <strong>overridden</strong>; the rest fall back to
            the role defaults from <code>shared/roles.ts</code>. Destructive
            tools (
            {KNOWN_TOOLS.filter((t) => t.destructive)
              .map((t) => t.id)
              .join(', ')}
            ) carry the most blast radius — narrow them on read-only roles.
          </p>

          <div className="tools-grid">
            <div className="tools-row tools-header">
              <span className="tools-role-cell" />
              {KNOWN_TOOLS.map((t) => (
                <span
                  key={t.id}
                  className={'tools-tool-head' + (t.destructive ? ' danger' : '')}
                  title={t.description}
                >
                  {t.id}
                </span>
              ))}
              <span className="tools-reset-cell" />
            </div>
            {ROLE_ORDER.map((role) => {
              const overridden = hasOverride(role);
              return (
                <div className="tools-row" key={role}>
                  <span className="tools-role-cell">
                    <span
                      className="role-tint"
                      style={{ background: ROLE_TINT[role], marginRight: 6 }}
                    />
                    <span className="tools-role-name">
                      {ROLES[role].label}
                    </span>
                    {overridden && (
                      <span
                        className="badge"
                        style={{
                          background: 'var(--sub-2)',
                          color: 'var(--waiting)',
                          marginLeft: 6,
                        }}
                      >
                        overridden
                      </span>
                    )}
                  </span>
                  {KNOWN_TOOLS.map((t) => {
                    const on = liveTools[role].has(t.id);
                    return (
                      <label
                        key={t.id}
                        className={'tools-cell' + (on ? ' on' : '')}
                        title={t.description}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggle(role, t.id)}
                        />
                      </label>
                    );
                  })}
                  <span className="tools-reset-cell">
                    {overridden ? (
                      <button
                        className="tb-btn"
                        style={{ height: 22 }}
                        onClick={() => resetRole(role)}
                        title="Reset this role to its default allow-list"
                      >
                        <Icon name="x" size={11} /> Reset
                      </button>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="settings-section">
          <h3 className="settings-h">Notes</h3>
          <p className="settings-help">
            Changes apply to <strong>new</strong> spawns and to redirected /
            forked sessions on their next turn. Agents that are already
            running keep the allow-list they started with. The Director runs
            without tools regardless — it plans only, never executes.
          </p>
        </section>
        </>
        )}
      </div>
    </div>
  );
}

const EXAMPLE_MCP_CONFIG = `{
  "mcpServers": {
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    }
  }
}`;

function McpEditor({
  project,
  onMcpChange,
}: {
  project: Project;
  onMcpChange: (
    config: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
}) {
  // Local draft state lets the user edit without spam-saving every
  // keystroke. The Save button commits and only then does the project
  // record (and the on-disk mirror file) update.
  const [draft, setDraft] = useState(project.mcpConfig ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Resync when the upstream project changes (e.g. switching projects).
  useEffect(() => {
    setDraft(project.mcpConfig ?? '');
    setError(null);
    setSaved(false);
  }, [project.id, project.mcpConfig]);

  const dirty = draft !== (project.mcpConfig ?? '');

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const value = draft.trim().length > 0 ? draft : null;
      const res = await onMcpChange(value);
      if (!res.ok) {
        setError(res.error ?? 'save failed');
      } else {
        setSaved(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await onMcpChange(null);
      if (!res.ok) {
        setError(res.error ?? 'clear failed');
      } else {
        setDraft('');
        setSaved(true);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section">
      <h3 className="settings-h">MCP server config</h3>
      <p className="settings-help">
        JSON config in the shape <code>claude --mcp-config</code> expects.
        Passed to every claude-provider spawn in this project — the
        Director and all auto-spawned agents inherit it. Saved per-project
        in app data; not committed to your workspace. See the{' '}
        <a
          href="https://modelcontextprotocol.io/quickstart/user"
          target="_blank"
          rel="noreferrer noopener"
        >
          MCP docs
        </a>{' '}
        for available servers and their setup.
      </p>
      {project.provider === 'codex' && project.directorProvider !== 'claude' && (
        <div
          className="inline-empty"
          style={{ padding: 14, marginBottom: 10 }}
        >
          This project runs against <code>codex exec</code>, which has no
          equivalent to <code>--mcp-config</code>. Anything saved here
          will sit on disk but never be applied — switch the project (or
          just the Director) to claude to make use of MCP.
        </div>
      )}
      <textarea
        className="text-input"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setSaved(false);
        }}
        placeholder={EXAMPLE_MCP_CONFIG}
        rows={18}
        spellCheck={false}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          whiteSpace: 'pre',
          overflowX: 'auto',
        }}
      />
      {error && (
        <div className="form-error" style={{ marginTop: 6 }}>
          {error}
        </div>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 8,
        }}
      >
        <button
          className="tb-btn primary"
          onClick={() => void save()}
          disabled={busy || !dirty}
          title={
            dirty
              ? 'Validate JSON and save for this project'
              : 'No unsaved changes'
          }
        >
          {busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
        {project.mcpConfig && (
          <button
            className="tb-btn"
            onClick={() => void clear()}
            disabled={busy}
            title="Drop the saved config; future spawns won't pass --mcp-config"
          >
            <Icon name="x" size={11} /> Clear
          </button>
        )}
        {saved && !dirty && !error && (
          <span style={{ color: 'var(--accent)', fontSize: 11 }}>
            Saved — next spawn picks it up.
          </span>
        )}
      </div>
    </section>
  );
}
