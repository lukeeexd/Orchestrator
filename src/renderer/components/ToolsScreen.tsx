import { useEffect, useMemo, useState } from 'react';
import type { AgentRole, Project } from '../../shared/types';
import { AGENT_ROLE_ORDER, ROLES, ROLE_TINT } from '../../shared/roles';
import { KNOWN_TOOLS } from '../../shared/tools';
import {
  MCP_PRESETS,
  parseMcpServers,
  stringifyMcpServers,
  type McpField,
  type McpPreset,
  type McpServerEntry,
} from '../../shared/mcpPresets';
import { Icon } from './Icon';
import { McpScaffoldWizard } from './McpScaffoldWizard';
import { SkillsEditor } from './SkillsEditor';
import { SecretsEditor } from './SecretsEditor';

interface Props {
  project: Project | null;
  onChange: (
    roleTools: Partial<Record<AgentRole, string[]>> | null,
  ) => Promise<void>;
  onMcpChange: (
    config: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
}

const ROLE_ORDER = AGENT_ROLE_ORDER;

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

  const [tab, setTab] = useState<'tools' | 'prompts' | 'mcp' | 'secrets'>(
    'tools',
  );

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
          title="Per-role configuration: tool allow-lists (claude only) or per-role prompt extensions (both providers). For Claude Code skills loaded from a marketplace, see the Marketplace rail item."
        >
          <button
            className={tab === 'tools' ? 'on' : ''}
            onClick={() => setTab('tools')}
          >
            tools
          </button>
          <button
            className={tab === 'prompts' ? 'on' : ''}
            onClick={() => setTab('prompts')}
            title="Per-role prompt extensions appended to each agent's system prompt at spawn time. For Claude Code skills loaded from a marketplace, see the Marketplace rail item."
          >
            prompts
          </button>
          <button
            className={tab === 'mcp' ? 'on' : ''}
            onClick={() => setTab('mcp')}
          >
            mcp
          </button>
          <button
            className={tab === 'secrets' ? 'on' : ''}
            onClick={() => setTab('secrets')}
            title="Project-scoped secrets injected as env vars into every agent spawn"
          >
            secrets
          </button>
        </div>
        <span className="spacer" />
      </div>

      <div className="settings-body">
        {tab === 'secrets' ? (
          <SecretsEditor project={project} />
        ) : tab === 'mcp' ? (
          <McpEditor project={project} onMcpChange={onMcpChange} />
        ) : tab === 'prompts' ? (
          <section className="settings-section">
            <h3 className="settings-h">Per-role prompt extensions</h3>
            <p className="settings-help">
              Markdown appended to each role&apos;s system prompt at spawn
              time. Lets you teach a role about your codebase&apos;s
              conventions without editing the hardcoded prompts. Saved
              per-project at{' '}
              <code>{`<workspace>/.orchestrator/skills/<role>.md`}</code>.
              Empty file means &quot;no extension&quot; (overrides any
              in-app default). Distinct from{' '}
              <strong>Marketplace</strong> skills — those are loaded as
              Claude Code plugins via <code>--plugin-dir</code> and
              surface as <code>/skill-name</code> commands the model can
              invoke on demand; these prompt extensions are static text
              that always shapes the role&apos;s disposition.
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
              <strong>prompts</strong> tab to author per-role guidance that
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
  // The preset modal — null when closed, otherwise the preset being
  // added or edited.
  const [modal, setModal] = useState<{
    preset: McpPreset;
    initial: Record<string, string>;
  } | null>(null);
  // P9 — scaffold wizard open state.
  const [wizardOpen, setWizardOpen] = useState(false);

  // Resync when the upstream project changes (e.g. switching projects).
  useEffect(() => {
    setDraft(project.mcpConfig ?? '');
    setError(null);
    setSaved(false);
  }, [project.id, project.mcpConfig]);

  const dirty = draft !== (project.mcpConfig ?? '');

  // Preset state is derived from the SAVED config (project.mcpConfig),
  // not the dirty draft — preset operations bypass the manual editor
  // so the user can't accidentally lose preset state to an unsaved
  // textarea edit.
  const installedServers = useMemo(
    () => parseMcpServers(project.mcpConfig),
    [project.mcpConfig],
  );

  const applyPresetChange = async (
    next: Record<string, McpServerEntry>,
  ): Promise<void> => {
    const nextStr = stringifyMcpServers(next);
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await onMcpChange(nextStr.length > 0 ? nextStr : null);
      if (!res.ok) {
        setError(res.error ?? 'save failed');
      } else {
        // Pull the textarea draft back in line with the saved config
        // so the user sees the merged JSON they just produced.
        setDraft(nextStr);
        setSaved(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const openAdd = (preset: McpPreset) => {
    if (preset.fields.length === 0) {
      // Zero-config preset: skip the modal, install immediately.
      void applyPresetChange({
        ...installedServers,
        [preset.id]: preset.build({}),
      });
      return;
    }
    setModal({ preset, initial: {} });
  };

  const openEdit = (preset: McpPreset) => {
    const existing = installedServers[preset.id];
    if (!existing) {
      openAdd(preset);
      return;
    }
    setModal({ preset, initial: preset.parse(existing) });
  };

  const removePreset = (preset: McpPreset) => {
    const next = { ...installedServers };
    delete next[preset.id];
    void applyPresetChange(next);
  };

  const handleModalSubmit = (values: Record<string, string>) => {
    if (!modal) return;
    const entry = modal.preset.build(values);
    setModal(null);
    void applyPresetChange({
      ...installedServers,
      [modal.preset.id]: entry,
    });
  };

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

      <h4
        className="settings-help"
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: 'var(--muted-2)',
          margin: '6px 0',
        }}
      >
        Presets
      </h4>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: 8,
          marginBottom: 14,
        }}
      >
        {MCP_PRESETS.map((p) => (
          <PresetCard
            key={p.id}
            preset={p}
            installed={!!installedServers[p.id]}
            disabled={busy}
            onAdd={() => openAdd(p)}
            onEdit={() => openEdit(p)}
            onRemove={() => removePreset(p)}
          />
        ))}
      </div>

      <h4
        className="settings-help"
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: 'var(--muted-2)',
          margin: '6px 0',
        }}
      >
        Build a custom server
      </h4>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          background: 'var(--sub-1)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          marginBottom: 14,
        }}
      >
        <div style={{ flex: 1, fontSize: 11, color: 'var(--text-2)' }}>
          Scaffold a TypeScript or Python MCP server under{' '}
          <code>{`<workspace>/.mcp-servers/<name>`}</code> with stub
          handlers for the capabilities you want, and auto-register
          it in this project&apos;s MCP config.
        </div>
        <button
          className="tb-btn primary"
          onClick={() => setWizardOpen(true)}
          disabled={busy || !project.workspace}
          title={
            !project.workspace
              ? 'Set a workspace folder first.'
              : 'Open the scaffold wizard'
          }
        >
          <Icon name="plus" size={11} /> Scaffold server
        </button>
      </div>

      <h4
        className="settings-help"
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: 'var(--muted-2)',
          margin: '6px 0',
        }}
      >
        JSON config (advanced)
      </h4>
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
      {modal && (
        <PresetModal
          preset={modal.preset}
          initial={modal.initial}
          onCancel={() => setModal(null)}
          onSubmit={handleModalSubmit}
        />
      )}
      {wizardOpen && (
        <McpScaffoldWizard
          projectId={project.id}
          onCancel={() => setWizardOpen(false)}
          onDone={() => setWizardOpen(false)}
        />
      )}
    </section>
  );
}

function PresetCard({
  preset,
  installed,
  disabled,
  onAdd,
  onEdit,
  onRemove,
}: {
  preset: McpPreset;
  installed: boolean;
  disabled: boolean;
  onAdd: () => void;
  onEdit: () => void;
  onRemove: () => void;
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
        <strong style={{ fontSize: 12 }}>{preset.label}</strong>
        {installed && (
          <span
            className="badge"
            style={{
              background: 'var(--sub-2)',
              color: 'var(--accent)',
              fontSize: 9,
            }}
          >
            installed
          </span>
        )}
        <span className="spacer" />
        {preset.docs && (
          <a
            href={preset.docs}
            target="_blank"
            rel="noreferrer noopener"
            style={{ fontSize: 11, color: 'var(--muted)' }}
            title="MCP server docs"
          >
            docs
          </a>
        )}
      </div>
      <p
        className="settings-help"
        style={{ fontSize: 11, margin: 0, lineHeight: 1.4 }}
      >
        {preset.description}
      </p>
      <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
        {installed ? (
          <>
            {preset.fields.length > 0 && (
              <button
                className="tb-btn"
                style={{ height: 22 }}
                onClick={onEdit}
                disabled={disabled}
                title="Edit this preset's configuration"
              >
                Edit
              </button>
            )}
            <button
              className="tb-btn"
              style={{ height: 22 }}
              onClick={onRemove}
              disabled={disabled}
              title="Remove this preset from the MCP config"
            >
              <Icon name="x" size={11} /> Remove
            </button>
          </>
        ) : (
          <button
            className="tb-btn primary"
            style={{ height: 22 }}
            onClick={onAdd}
            disabled={disabled}
            title={
              preset.fields.length === 0
                ? 'Install — no configuration needed'
                : 'Configure and install'
            }
          >
            <Icon name="check" size={11} /> Add
          </button>
        )}
      </div>
    </div>
  );
}

function PresetModal({
  preset,
  initial,
  onCancel,
  onSubmit,
}: {
  preset: McpPreset;
  initial: Record<string, string>;
  onCancel: () => void;
  onSubmit: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const f of preset.fields) out[f.key] = initial[f.key] ?? '';
    return out;
  });
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    for (const f of preset.fields) {
      if (f.required && !values[f.key]?.trim()) {
        setError(`${f.label} is required.`);
        return;
      }
    }
    onSubmit(values);
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
            <b>Configure {preset.label}</b>
          </span>
          <span className="spacer" />
          <button className="icon-btn" onClick={onCancel} title="Cancel">
            <Icon name="x" size={11} />
          </button>
        </div>
        <div className="modal-body">
          {preset.fields.map((field) => (
            <PresetFieldRow
              key={field.key}
              field={field}
              value={values[field.key] ?? ''}
              onChange={(v) => {
                setValues((prev) => ({ ...prev, [field.key]: v }));
                setError(null);
              }}
            />
          ))}
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
          <button className="tb-btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="tb-btn primary" onClick={submit}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function PresetFieldRow({
  field,
  value,
  onChange,
}: {
  field: McpField;
  value: string;
  onChange: (next: string) => void;
}) {
  const isMulti = field.type === 'paths';
  return (
    <div className="field">
      <span className="lbl">
        {field.label}
        {field.required && (
          <span style={{ color: 'var(--accent)' }}> *</span>
        )}
      </span>
      {isMulti ? (
        <textarea
          className="text-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          rows={4}
          spellCheck={false}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
        />
      ) : (
        <input
          className="text-input"
          type={field.type === 'password' ? 'password' : 'text'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          spellCheck={false}
        />
      )}
      {field.help && (
        <span
          className="meta"
          style={{
            fontSize: 11,
            color: 'var(--muted)',
            marginTop: 2,
          }}
        >
          {field.help}
        </span>
      )}
    </div>
  );
}
