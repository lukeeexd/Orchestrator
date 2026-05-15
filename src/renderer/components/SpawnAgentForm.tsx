import { useEffect, useState } from 'react';
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
  /** Pre-fill the workspace input from the global workspace. User can override. */
  defaultWorkspace: string;
}

interface AttachmentChip {
  path: string;
  name: string;
  ok: boolean;
  reason?: string;
}

export function SpawnAgentForm({ onCancel, onSpawned, defaultWorkspace }: Props) {
  const [role, setRole] = useState<AgentRole>('coder');
  const [workspace, setWorkspace] = useState(defaultWorkspace);
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [budgetUsd, setBudgetUsd] = useState('');
  const [budgetTokens, setBudgetTokens] = useState('');
  const [budgetSeconds, setBudgetSeconds] = useState('');
  const [attachments, setAttachments] = useState<AttachmentChip[]>([]);
  const [defaults, setDefaults] = useState<{
    usd: number;
    tokens: number;
    seconds: number;
  } | null>(null);

  useEffect(() => {
    window.api.getSettings().then((s) => {
      setDefaults({
        usd: s.defaultBudgetUsd,
        tokens: s.defaultBudgetTokens,
        seconds: s.defaultBudgetSeconds,
      });
    });
  }, []);

  const pickWorkspace = async () => {
    const { path } = await window.api.pickWorkspace();
    if (path) setWorkspace(path);
  };

  const pickAttachments = async () => {
    const { attachments: picked } = await window.api.pickAttachments();
    if (picked.length > 0) {
      setAttachments((prev) => [...prev, ...picked]);
    }
  };

  const removeAttachment = (path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  };

  const parseNum = (raw: string): number | undefined => {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return n;
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
      const budget = {
        usd: parseNum(budgetUsd),
        tokens: parseNum(budgetTokens),
        seconds: parseNum(budgetSeconds),
      };
      const hasBudget =
        budget.usd != null || budget.tokens != null || budget.seconds != null;
      const okAttachments = attachments.filter((a) => a.ok).map((a) => a.path);
      await window.api.spawnAgent({
        role,
        workspace,
        task,
        ...(hasBudget ? { budget } : {}),
        ...(okAttachments.length > 0 ? { attachments: okAttachments } : {}),
      });
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

          <div className="field">
            <span className="lbl">
              Attachments · optional · text files only (md / code / config)
            </span>
            <div className="att-row" style={{ marginBottom: 4 }}>
              {attachments.map((a) => (
                <span
                  className={'att-chip' + (a.ok ? '' : ' bad')}
                  key={a.path}
                  title={a.reason ?? a.path}
                >
                  <Icon name="attach" size={10} />
                  {a.name}
                  <button
                    className="att-x"
                    onClick={() => removeAttachment(a.path)}
                    title="Remove"
                  >
                    ×
                  </button>
                </span>
              ))}
              <button
                className="tb-btn"
                style={{ height: 22 }}
                onClick={pickAttachments}
              >
                <Icon name="attach" size={11} /> Attach files
              </button>
            </div>
          </div>

          <div className="field">
            <span className="lbl">
              Budget caps · optional · leave blank for defaults
            </span>
            <div className="budget-row">
              <label>
                <span className="budget-prefix">$</span>
                <input
                  className="text-input"
                  value={budgetUsd}
                  onChange={(e) => setBudgetUsd(e.target.value)}
                  placeholder={defaults?.usd.toFixed(2) ?? '—'}
                  inputMode="decimal"
                />
              </label>
              <label>
                <input
                  className="text-input"
                  value={budgetTokens}
                  onChange={(e) => setBudgetTokens(e.target.value)}
                  placeholder={defaults?.tokens.toLocaleString() ?? '—'}
                  inputMode="numeric"
                />
                <span className="budget-suffix">tokens</span>
              </label>
              <label>
                <input
                  className="text-input"
                  value={budgetSeconds}
                  onChange={(e) => setBudgetSeconds(e.target.value)}
                  placeholder={defaults?.seconds.toString() ?? '—'}
                  inputMode="numeric"
                />
                <span className="budget-suffix">seconds</span>
              </label>
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
