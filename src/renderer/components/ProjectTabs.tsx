import { useState } from 'react';
import type { Project } from '../../shared/types';
import { Icon } from './Icon';

interface Props {
  projects: Project[];
  activeId: string | null;
  agentCountByProject: Record<string, number>;
  onSelect: (id: string) => void;
  onNewProject: () => void;
}

export function ProjectTabs({
  projects,
  activeId,
  agentCountByProject,
  onSelect,
  onNewProject,
}: Props) {
  return (
    <div className="project-tabs">
      {projects.map((p) => {
        const count = agentCountByProject[p.id] ?? 0;
        return (
          <div
            key={p.id}
            className={'project-tab' + (activeId === p.id ? ' on' : '')}
            onClick={() => onSelect(p.id)}
            title={p.workspace || 'no workspace'}
          >
            <span className="pt-name">{p.name}</span>
            {count > 0 && <span className="pt-count">{count}</span>}
          </div>
        );
      })}
      <button
        className="project-tab project-tab-new"
        onClick={onNewProject}
        title="New project"
      >
        <Icon name="plus" size={11} />
      </button>
    </div>
  );
}

interface NewProjectFormProps {
  onCreate: (name: string, workspace: string) => Promise<void>;
  onCancel: () => void;
}

export function NewProjectForm({ onCreate, onCancel }: NewProjectFormProps) {
  const [name, setName] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickWorkspace = async () => {
    const { path } = await window.api.pickWorkspace();
    if (path) setWorkspace(path);
  };

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError('Give the project a name.');
      return;
    }
    setBusy(true);
    try {
      await onCreate(name.trim(), workspace.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="title">
            <b>New project</b>
          </span>
          <span className="spacer" />
          <button className="icon-btn" onClick={onCancel} title="Cancel">
            <Icon name="x" size={11} />
          </button>
        </div>

        <div className="modal-body">
          <div className="field">
            <span className="lbl">Name</span>
            <input
              className="text-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Stripe onboarding"
              autoFocus
            />
          </div>

          <div className="field">
            <span className="lbl">Workspace folder · optional</span>
            <div className="workspace-row">
              <input
                className="text-input"
                value={workspace}
                onChange={(e) => setWorkspace(e.target.value)}
                placeholder="C:\path\to\repo (or leave blank to set later)"
              />
              <button className="tb-btn" onClick={pickWorkspace}>
                Browse…
              </button>
            </div>
          </div>

          {error && <div className="form-error">{error}</div>}
        </div>

        <div className="modal-foot">
          <button className="tb-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="tb-btn primary"
            onClick={() => void submit()}
            disabled={busy || !name.trim()}
          >
            <Icon name="plus" size={11} /> Create
          </button>
        </div>
      </div>
    </div>
  );
}
