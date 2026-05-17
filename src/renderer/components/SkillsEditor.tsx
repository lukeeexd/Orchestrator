import { useEffect, useState } from 'react';
import type { AgentRole, Project } from '../../shared/types';
import type { SkillEntry } from '../../shared/ipc';
import { ROLES } from '../../shared/roles';
import { Icon } from './Icon';

const ROLE_TINT: Record<AgentRole, string> = {
  pm: '#4ade80',
  researcher: '#60a5fa',
  coder: '#c084fc',
  qa: '#fbbf24',
  devops: '#f97316',
  security: '#f87171',
};

const ROLE_ORDER: AgentRole[] = [
  'pm',
  'researcher',
  'coder',
  'qa',
  'devops',
  'security',
];

interface Props {
  project: Project;
}

interface RoleDraft {
  entry: SkillEntry;
  /** User-edited content; differs from entry.content while there's an unsaved change. */
  draft: string;
  busy: boolean;
  error: string | null;
}

export function SkillsEditor({ project }: Props) {
  const [drafts, setDrafts] = useState<Record<AgentRole, RoleDraft> | null>(
    null,
  );
  const [active, setActive] = useState<AgentRole>('coder');

  useEffect(() => {
    let mounted = true;
    void (async () => {
      const entries = await window.api.listSkills(project.id);
      if (!mounted) return;
      const map: Partial<Record<AgentRole, RoleDraft>> = {};
      for (const e of entries) {
        map[e.role] = { entry: e, draft: e.content, busy: false, error: null };
      }
      setDrafts(map as Record<AgentRole, RoleDraft>);
    })();
    return () => {
      mounted = false;
    };
  }, [project.id]);

  if (!drafts) {
    return (
      <div className="empty" style={{ height: 'auto', padding: 32 }}>
        <div className="empty-body">Loading skills…</div>
      </div>
    );
  }

  const current = drafts[active];
  const dirty = current.draft !== current.entry.content;
  const noWorkspace = !project.workspace;

  const save = async () => {
    setDrafts((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        [active]: { ...prev[active], busy: true, error: null },
      };
    });
    const res = await window.api.setSkill(project.id, active, current.draft);
    setDrafts((prev) => {
      if (!prev) return prev;
      if (!res.ok) {
        return {
          ...prev,
          [active]: { ...prev[active], busy: false, error: res.error ?? 'save failed' },
        };
      }
      const entry = res.entry as SkillEntry;
      return {
        ...prev,
        [active]: {
          entry,
          draft: entry.content,
          busy: false,
          error: null,
        },
      };
    });
  };

  const revertToDisk = () => {
    setDrafts((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        [active]: { ...prev[active], draft: prev[active].entry.content, error: null },
      };
    });
  };

  const reloadFromDisk = async () => {
    const entries = await window.api.listSkills(project.id);
    const map: Partial<Record<AgentRole, RoleDraft>> = {};
    for (const e of entries) {
      map[e.role] = { entry: e, draft: e.content, busy: false, error: null };
    }
    setDrafts(map as Record<AgentRole, RoleDraft>);
  };

  return (
    <div className="skills-editor">
      {noWorkspace && (
        <div
          className="inline-empty"
          style={{ marginBottom: 12, padding: 12, textAlign: 'left' }}
        >
          <strong>Set a workspace folder first.</strong> Skill files live at{' '}
          <code>{`<workspace>/.orchestrator/skills/<role>.md`}</code> on
          disk; without a workspace they can't be saved. Editing still
          works in this view but the Save button is disabled.
        </div>
      )}
      <div className="skills-tabs">
        {ROLE_ORDER.map((role) => {
          const has = drafts[role].entry.hasFile;
          return (
            <button
              key={role}
              className={'skills-tab' + (active === role ? ' on' : '')}
              onClick={() => setActive(role)}
              style={{
                borderColor: active === role ? ROLE_TINT[role] : undefined,
              }}
            >
              <span
                className="role-tint"
                style={{ background: ROLE_TINT[role] }}
              />
              <span>{ROLES[role].label}</span>
              {has && <span className="skills-tab-dot" title="Saved on disk" />}
            </button>
          );
        })}
      </div>

      <div className="skills-meta">
        <span>
          {current.entry.hasFile ? (
            <>
              Loaded from{' '}
              <code style={{ fontSize: 10 }}>{current.entry.path}</code>
            </>
          ) : (
            <em>
              No file on disk yet — editing the in-app default. Save to
              create the file.
            </em>
          )}
        </span>
        <span className="spacer" />
        <button
          className="tb-btn"
          onClick={() => void reloadFromDisk()}
          title="Re-read all role skill files from disk (picks up external edits)."
        >
          <Icon name="redirect" size={11} /> Reload
        </button>
      </div>

      <textarea
        className="text-input skills-textarea"
        value={current.draft}
        onChange={(e) =>
          setDrafts((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              [active]: { ...prev[active], draft: e.target.value, error: null },
            };
          })
        }
        placeholder={`Write a skill prompt for ${ROLES[active].label}. Appended to the role's system prompt at spawn time. Empty = no skill (overrides any in-app default to nothing).`}
        spellCheck={false}
      />

      {current.error && <div className="form-error">{current.error}</div>}

      <div className="skills-foot">
        {dirty && (
          <span className="meta" style={{ color: 'var(--waiting)' }}>
            unsaved changes
          </span>
        )}
        <span className="spacer" />
        <button
          className="tb-btn"
          onClick={revertToDisk}
          disabled={!dirty || current.busy}
        >
          Revert
        </button>
        <button
          className="tb-btn primary"
          onClick={() => void save()}
          disabled={!dirty || current.busy || noWorkspace}
          title={
            noWorkspace
              ? 'Set a workspace folder first.'
              : 'Save this role’s skill to disk.'
          }
        >
          <Icon name="check" size={11} />{' '}
          {current.busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
