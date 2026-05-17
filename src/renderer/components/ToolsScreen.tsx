import { useMemo, useState } from 'react';
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

export function ToolsScreen({ project, onChange }: Props) {
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

  const [tab, setTab] = useState<'tools' | 'skills'>('tools');

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
        </div>
        <span className="spacer" />
      </div>

      <div className="settings-body">
        {tab === 'skills' ? (
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
