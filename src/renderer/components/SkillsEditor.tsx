import { useEffect, useState } from 'react';
import type { AgentRole, Project, SkillKey } from '../../shared/types';
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

/** Director sits first; agent roles in execution order after. */
const SKILL_ORDER: SkillKey[] = [
  'director',
  'pm',
  'researcher',
  'coder',
  'qa',
  'devops',
  'security',
];

function tintFor(key: SkillKey): string {
  return key === 'director' ? 'var(--accent)' : ROLE_TINT[key];
}

function labelFor(key: SkillKey): string {
  return key === 'director' ? 'Director' : ROLES[key].label;
}

interface Props {
  project: Project;
}

interface Draft {
  entry: SkillEntry;
  /** User-edited content; differs from entry.content while there's an unsaved change. */
  draft: string;
  busy: boolean;
  error: string | null;
}

export function SkillsEditor({ project }: Props) {
  const [drafts, setDrafts] = useState<Record<SkillKey, Draft> | null>(null);
  const [active, setActive] = useState<SkillKey>('coder');

  useEffect(() => {
    let mounted = true;
    void (async () => {
      const entries = await window.api.listSkills(project.id);
      if (!mounted) return;
      const map: Partial<Record<SkillKey, Draft>> = {};
      for (const e of entries) {
        map[e.key] = { entry: e, draft: e.content, busy: false, error: null };
      }
      setDrafts(map as Record<SkillKey, Draft>);
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
    const map: Partial<Record<SkillKey, Draft>> = {};
    for (const e of entries) {
      map[e.key] = { entry: e, draft: e.content, busy: false, error: null };
    }
    setDrafts(map as Record<SkillKey, Draft>);
  };

  return (
    <div className="skills-editor">
      {noWorkspace && (
        <div
          className="inline-empty"
          style={{ marginBottom: 12, padding: 12, textAlign: 'left' }}
        >
          <strong>Set a workspace folder first.</strong> Skill files live at{' '}
          <code>{`<workspace>/.orchestrator/skills/<key>.md`}</code> on
          disk; without a workspace they can't be saved. Editing still
          works in this view but the Save button is disabled.
        </div>
      )}
      <div className="skills-tabs">
        {SKILL_ORDER.map((key) => {
          const has = drafts[key].entry.hasFile;
          return (
            <button
              key={key}
              className={'skills-tab' + (active === key ? ' on' : '')}
              onClick={() => setActive(key)}
              style={{
                borderColor: active === key ? tintFor(key) : undefined,
              }}
            >
              <span
                className="role-tint"
                style={{ background: tintFor(key) }}
              />
              <span>{labelFor(key)}</span>
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
          title="Re-read all skill files from disk (picks up external edits)."
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
        placeholder={
          active === 'director'
            ? "Project-specific guidance for the Director — codebase conventions, team norms, things you'd otherwise have to restate every turn. Appended to the Director's system prompt at every turn."
            : `Write a skill prompt for ${labelFor(active)}. Appended to the role's system prompt at spawn time. Empty = no skill (overrides any in-app default to nothing).`
        }
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
              : "Save this entry's skill to disk."
          }
        >
          <Icon name="check" size={11} />{' '}
          {current.busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
