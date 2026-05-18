import { useEffect, useState } from 'react';
import type { ClipboardEvent, DragEvent } from 'react';
import type {
  AgentRole,
  EffortLevel,
  Provider,
} from '../../shared/types';
import { Icon } from './Icon';
import { AttachmentThumb } from './AttachmentThumb';
import { ModelPicker } from './ModelPicker';
import { EffortPicker } from './EffortPicker';
import {
  handleAttachmentDrop,
  handleAttachmentPaste,
} from '../lib/attachmentDataTransfer';

const ROLES: { id: AgentRole; label: string; tint: string }[] = [
  { id: 'pm', label: 'Project Manager', tint: '#4ade80' },
  { id: 'researcher', label: 'Researcher', tint: '#60a5fa' },
  { id: 'coder', label: 'Coder', tint: '#c084fc' },
  { id: 'qa', label: 'QA', tint: '#fbbf24' },
  { id: 'devops', label: 'DevOps', tint: '#f97316' },
  { id: 'security', label: 'Security', tint: '#f87171' },
];

interface Props {
  onCancel: () => void;
  onSpawned: () => void;
  /** Pre-fill the workspace input from the active project's workspace. */
  defaultWorkspace: string;
  /** Pre-fill the model from the project's Director model. */
  defaultModel: string;
  /** Pre-fill the effort from the project's Director effort. */
  defaultEffort: EffortLevel;
  projectId: string;
  provider: Provider;
}

interface AttachmentChip {
  path: string;
  name: string;
  ok: boolean;
  reason?: string;
}

export function SpawnAgentForm({
  onCancel,
  onSpawned,
  defaultWorkspace,
  defaultModel,
  defaultEffort,
  projectId,
  provider,
}: Props) {
  const [role, setRole] = useState<AgentRole>('coder');
  const [workspace, setWorkspace] = useState(defaultWorkspace);
  // Provider starts at the project's default; user can flip for one
  // spawn without changing the project itself. When the provider
  // changes mid-form we blank the model so the runner cascades to the
  // new provider's default (the existing model id won't validate
  // against the new provider).
  const [agentProvider, setAgentProvider] = useState<Provider>(provider);
  const [model, setModel] = useState(defaultModel);
  const [effort, setEffort] = useState<EffortLevel>(defaultEffort);
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
    // Fire-and-forget cleanup. Main-side gate ensures only ephemeral
    // paste-temp files are deleted; picked attachments outside our
    // managed dir are silently ignored.
    if (path) void window.api.disposeAttachment(path);
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
        projectId,
        role,
        workspace,
        task,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(agentProvider !== provider ? { provider: agentProvider } : {}),
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
            <span className="lbl">
              Provider · project default is {provider}
            </span>
            <div style={{ display: 'flex', gap: 4 }}>
              {(['claude', 'codex'] as const).map((p) => (
                <button
                  key={p}
                  className={
                    'tb-btn' + (agentProvider === p ? ' primary' : '')
                  }
                  onClick={() => {
                    if (agentProvider === p) return;
                    setAgentProvider(p);
                    // Switching providers invalidates the current model
                    // pick — let the runner cascade to the new
                    // provider's default rather than forcing the user
                    // to re-select.
                    setModel('');
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span className="lbl">Model</span>
            <ModelPicker
              value={model}
              onChange={setModel}
              provider={agentProvider}
            />
          </div>

          {agentProvider === 'claude' && (
            <div className="field">
              <span className="lbl">Reasoning effort</span>
              <EffortPicker value={effort} onChange={setEffort} />
            </div>
          )}

          <div className="field">
            <span className="lbl">Task</span>
            <textarea
              className="text-input task-input"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onPaste={(e: ClipboardEvent<HTMLTextAreaElement>) => {
                void handleAttachmentPaste(e, (info) =>
                  setAttachments((prev) => [...prev, info]),
                );
              }}
              onDragOver={(e: DragEvent<HTMLTextAreaElement>) =>
                e.preventDefault()
              }
              onDrop={(e: DragEvent<HTMLTextAreaElement>) => {
                void handleAttachmentDrop(e, (info) =>
                  setAttachments((prev) => [...prev, info]),
                );
              }}
              placeholder="Describe what you want the agent to do… (paste or drop files to attach)"
              rows={6}
            />
          </div>

          <div className="field">
            <span className="lbl">
              Attachments · optional · text / images / PDF · paste, drop, or pick
            </span>
            <div className="att-row" style={{ marginBottom: 4 }}>
              {attachments.map((a) => (
                <span
                  className={'att-chip' + (a.ok ? '' : ' bad')}
                  key={a.path}
                  title={a.reason ?? a.path}
                >
                  <AttachmentThumb path={a.path} />
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
                  placeholder={
                    defaults && defaults.usd > 0
                      ? defaults.usd.toFixed(2)
                      : 'no cap'
                  }
                  inputMode="decimal"
                />
              </label>
              <label>
                <input
                  className="text-input"
                  value={budgetTokens}
                  onChange={(e) => setBudgetTokens(e.target.value)}
                  placeholder={
                    defaults && defaults.tokens > 0
                      ? defaults.tokens.toLocaleString()
                      : 'no cap'
                  }
                  inputMode="numeric"
                />
                <span className="budget-suffix">tokens</span>
              </label>
              <label>
                <input
                  className="text-input"
                  value={budgetSeconds}
                  onChange={(e) => setBudgetSeconds(e.target.value)}
                  placeholder={
                    defaults && defaults.seconds > 0
                      ? defaults.seconds.toString()
                      : 'no cap'
                  }
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
