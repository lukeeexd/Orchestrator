import { useState } from 'react';
import type { Project } from '../../shared/types';
import { Icon } from './Icon';
import { Modal } from './Modal';

interface Props {
  projects: Project[];
  activeId: string | null;
  agentCountByProject: Record<string, number>;
  onSelect: (id: string) => void;
  onNewProject: () => void;
  onDelete: (id: string) => void;
}

export function ProjectTabs({
  projects,
  activeId,
  agentCountByProject,
  onSelect,
  onNewProject,
  onDelete,
}: Props) {
  return (
    <div className="project-tabs">
      {projects.map((p) => {
        const count = agentCountByProject[p.id] ?? 0;
        const canDelete = projects.length > 1;
        return (
          <div
            key={p.id}
            className={'project-tab' + (activeId === p.id ? ' on' : '')}
            onClick={() => onSelect(p.id)}
            title={
              `${p.workspace || 'no workspace set'} · runtime: ${p.provider}`
            }
          >
            <span className="pt-name">{p.name}</span>
            {p.provider === 'codex' && (
              <span
                className="pt-count"
                style={{ background: 'var(--sub-2)', color: 'var(--muted)' }}
              >
                codex
              </span>
            )}
            {count > 0 && <span className="pt-count">{count}</span>}
            {canDelete && (
              <button
                className="pt-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(p.id);
                }}
                title="Remove project (workspace files on disk are NOT deleted)"
              >
                ×
              </button>
            )}
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
  onCreate: (
    name: string,
    workspace: string,
    provider: import('../../shared/types').Provider,
  ) => Promise<void>;
  onCancel: () => void;
}

export function NewProjectForm({ onCreate, onCancel }: NewProjectFormProps) {
  const [name, setName] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [provider, setProvider] = useState<
    import('../../shared/types').Provider
  >('claude');
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
      await onCreate(name.trim(), workspace.trim(), provider);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={<b>New project</b>}
      onClose={busy ? undefined : onCancel}
      footer={
        <>
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
        </>
      }
    >
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

          <div className="field">
            <span className="lbl">Agent runtime</span>
            <div className="mode-toggle">
              <button
                className={provider === 'claude' ? 'on' : ''}
                onClick={() => setProvider('claude')}
              >
                claude
              </button>
              <button
                className={provider === 'codex' ? 'on' : ''}
                onClick={() => setProvider('codex')}
              >
                codex
              </button>
            </div>
            <span
              className="meta"
              style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}
            >
              Which CLI the Director + agents spawn against. Picked at
              creation; can&apos;t be changed later. Requires the matching
              binary on your PATH.
            </span>
          </div>

          {error && <div className="form-error">{error}</div>}
    </Modal>
  );
}

interface ConfirmDeleteProps {
  project: Project;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

export function ConfirmDeleteProject({
  project,
  onConfirm,
  onCancel,
}: ConfirmDeleteProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={<b>Remove project</b>}
      onClose={busy ? undefined : onCancel}
      footer={
        <>
          <button className="tb-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="tb-btn primary"
            style={{
              background: 'rgba(239,91,91,0.18)',
              borderColor: 'rgba(239,91,91,0.5)',
              color: 'var(--error)',
            }}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            <Icon name="x" size={11} /> Remove
          </button>
        </>
      }
    >
      <div className="field">
        <span className="v">
          Remove <code>{project.name}</code> from the orchestrator?
        </span>
      </div>
      <div className="field">
        <span className="lbl">Wiped</span>
        <span className="v">
          Director chat history, agent rows, log lines, and the SDK
          session id for this project.
        </span>
      </div>
      <div className="field">
        <span className="lbl">Not touched</span>
        <span className="v">
          {project.workspace ? (
            <>
              Workspace folder at <code>{project.workspace}</code> — any
              files agents created stay on disk.
            </>
          ) : (
            <>No workspace was set, so nothing on disk to leave behind.</>
          )}
        </span>
      </div>
    </Modal>
  );
}
