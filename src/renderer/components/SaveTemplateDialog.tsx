import { useState } from 'react';
import type {
  AgentRole,
  DirectorMode,
  PlanRow,
  Template,
} from '../../shared/types';
import { Icon } from './Icon';

const ROLE_TINT: Record<AgentRole, string> = {
  pm: '#4ade80',
  researcher: '#60a5fa',
  coder: '#c084fc',
  qa: '#fbbf24',
  devops: '#f97316',
  security: '#f87171',
};

interface Props {
  /** Rows captured from the current PlanCard. Stored verbatim (after renumbering at the runner). */
  rows: PlanRow[];
  /** Surfaced in the dialog as a read-only hint; user can change post-save. */
  mode: DirectorMode;
  onSave: (input: {
    name: string;
    description: string;
    tags: string[];
    mode: DirectorMode;
  }) => Promise<Template | null>;
  onCancel: () => void;
}

export function SaveTemplateDialog({ rows, mode, onSave, onCancel }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tagsRaw, setTagsRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError('Name is required.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const tags = tagsRaw
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const result = await onSave({
        name: trimmed,
        description: description.trim(),
        tags,
        mode,
      });
      if (!result) {
        setError('Failed to save template.');
        return;
      }
      // Success — parent closes the dialog.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 460 }}
      >
        <div className="modal-head">
          <span className="title">
            <b>Save as template</b>
          </span>
          <span className="spacer" />
          <button className="icon-btn" onClick={onCancel} title="Cancel">
            <Icon name="x" size={11} />
          </button>
        </div>

        <div className="modal-body">
          <div className="field">
            <span className="lbl">Name</span>
            <span className="v">
              <input
                className="text-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Ship a feature with TDD"
                autoFocus
                style={{ width: '100%' }}
              />
            </span>
          </div>

          <div className="field">
            <span className="lbl">Description</span>
            <span className="v">
              <input
                className="text-input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="One-line summary shown in the Templates list (optional)"
                style={{ width: '100%' }}
              />
            </span>
          </div>

          <div className="field">
            <span className="lbl">Tags</span>
            <span className="v">
              <input
                className="text-input"
                value={tagsRaw}
                onChange={(e) => setTagsRaw(e.target.value)}
                placeholder="comma, separated (optional)"
                style={{ width: '100%' }}
              />
            </span>
          </div>

          <div className="field">
            <span className="lbl">Mode</span>
            <span
              className="v"
              style={{ color: 'var(--text-2)', fontSize: 11 }}
            >
              {mode === 'auto'
                ? 'auto · Director keeps orchestrating after spawn'
                : 'manual · advisor mode, no auto-spawn'}
            </span>
          </div>

          <div className="field">
            <span className="lbl">Rows</span>
            <span className="v" style={{ flex: 1 }}>
              <div
                style={{
                  background: 'var(--sub-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  padding: '6px 8px',
                }}
              >
                {rows.map((r, idx) => (
                  <div
                    key={`${r.name}-${idx}`}
                    className="plan-row"
                    style={{
                      fontSize: 11,
                      padding: '2px 0',
                      alignItems: 'flex-start',
                    }}
                  >
                    <span className="num">
                      {String(r.i).padStart(2, '0')}
                    </span>
                    <span className="tree">
                      {idx === rows.length - 1 ? '└─' : '├─'}
                    </span>
                    <span
                      className="who"
                      style={{ color: ROLE_TINT[r.role], minWidth: 70 }}
                    >
                      {r.role}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        color: 'var(--text-1)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={r.task}
                    >
                      {r.task}
                    </span>
                  </div>
                ))}
              </div>
            </span>
          </div>

          {error && (
            <div
              className="field"
              style={{ color: 'var(--error)', fontSize: 11 }}
            >
              {error}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="tb-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="tb-btn primary"
            onClick={() => void handleSave()}
            disabled={busy || name.trim().length === 0}
          >
            {busy ? 'Saving…' : 'Save template'}
          </button>
        </div>
      </div>
    </div>
  );
}
