import { useState } from 'react';
import type { AgentRole } from '../../shared/types';
import { Icon } from './Icon';

const ROLES: { id: AgentRole; label: string; tint: string }[] = [
  { id: 'pm', label: 'Project Manager', tint: '#4ade80' },
  { id: 'researcher', label: 'Researcher', tint: '#60a5fa' },
  { id: 'coder', label: 'Coder', tint: '#c084fc' },
  { id: 'qa', label: 'QA', tint: '#fbbf24' },
  { id: 'devops', label: 'DevOps', tint: '#f97316' },
];

interface Props {
  onCancel: () => void;
  onSpawned: () => void;
}

export function SpawnAgentForm({ onCancel, onSpawned }: Props) {
  const [role, setRole] = useState<AgentRole>('coder');
  const [workspace, setWorkspace] = useState('');
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickWorkspace = async () => {
    const { path } = await window.api.pickWorkspace();
    if (path) setWorkspace(path);
  };

  const submit = async () => {
    setError(null);
    if (!workspace.trim()) {
      setError('Pick a workspace folder.');
      return;
    }
    if (!task.trim()) {
      setError('Describe the task.');
      return;
    }
    setBusy(true);
    try {
      await window.api.spawnAgent({ role, workspace, task });
      onSpawned();
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
            <b>Spawn agent</b>
          </span>
          <span className="spacer" />
          <button className="icon-btn" onClick={onCancel} title="Cancel">
            <Icon name="x" size={11} />
          </button>
        </div>

        <div className="modal-body">
          <div className="field">
            <span className="lbl">Role</span>
            <div className="role-picker">
              {ROLES.map((r) => (
                <button
                  key={r.id}
                  className={'role-chip' + (role === r.id ? ' on' : '')}
                  onClick={() => setRole(r.id)}
                  style={{ borderColor: role === r.id ? r.tint : undefined }}
                >
                  <span
                    className="role-tint"
                    style={{ background: r.tint }}
                  />
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span className="lbl">Workspace folder</span>
            <div className="workspace-row">
              <input
                className="text-input"
                value={workspace}
                onChange={(e) => setWorkspace(e.target.value)}
                placeholder="C:\path\to\your\repo"
              />
              <button className="tb-btn" onClick={pickWorkspace}>
                Browse…
              </button>
            </div>
          </div>

          <div className="field">
            <span className="lbl">Task</span>
            <textarea
              className="text-input task-input"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="Describe what you want the agent to do…"
              rows={6}
            />
          </div>

          {error && <div className="form-error">{error}</div>}
        </div>

        <div className="modal-foot">
          <button className="tb-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="tb-btn primary"
            onClick={submit}
            disabled={busy}
          >
            <Icon name="play" size={11} /> Spawn
          </button>
        </div>
      </div>
    </div>
  );
}
