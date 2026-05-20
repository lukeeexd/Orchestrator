import { useEffect, useMemo, useState } from 'react';
import type {
  AgentRole,
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
  projectId: string | null;
  /**
   * Called after a template is picked + the synthetic Director message
   * lands. The parent switches the active rail back to `agents` so the
   * user sees the PlanCard immediately.
   */
  onTemplateUsed: () => void;
}

export function TemplatesScreen({ projectId, onTemplateUsed }: Props) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [reloading, setReloading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = async () => {
    setReloading(true);
    try {
      const next = await window.api.listTemplates();
      setTemplates(next);
    } finally {
      setReloading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => {
    if (!templates) return [];
    const q = search.trim().toLowerCase();
    if (q.length === 0) return templates;
    return templates.filter((t) => {
      const hay = `${t.name} ${t.description} ${t.tags.join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  }, [templates, search]);

  const handleUse = async (tpl: Template) => {
    if (!projectId) return;
    setBusyId(tpl.id);
    try {
      const res = await window.api.useTemplate(projectId, tpl.id);
      if (!res.ok) {
        console.error('[templates] use failed:', res.error);
        return;
      }
      onTemplateUsed();
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (tpl: Template) => {
    setBusyId(tpl.id);
    try {
      const res = await window.api.deleteTemplate(tpl.id);
      if (res.ok) {
        setTemplates((prev) =>
          prev ? prev.filter((t) => t.id !== tpl.id) : prev,
        );
      }
    } finally {
      setBusyId(null);
      setConfirmDeleteId(null);
    }
  };

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="pane settings-pane" style={{ flex: 1 }}>
      <div className="pane-head">
        <span className="title">
          <b>Templates</b>
        </span>
        <span className="spacer" />
        <input
          className="text-input"
          placeholder="Search by name, description, or tag…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 260, height: 22, fontSize: 11 }}
        />
        <button
          className="tb-btn"
          onClick={() => void load()}
          disabled={reloading}
          title="Reload from disk"
          style={{ marginLeft: 8 }}
        >
          <Icon name="redirect" size={11} /> {reloading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div className="settings-body">
        {!projectId && (
          <div
            className="empty"
            style={{
              padding: '12px 16px',
              fontSize: 11,
              color: 'var(--text-2)',
            }}
          >
            Select or create a project — templates spawn agents into a workspace,
            so they need a project to land in.
          </div>
        )}

        {templates === null ? (
          <div
            className="empty"
            style={{ padding: '12px 16px', fontSize: 11 }}
          >
            Loading templates…
          </div>
        ) : filtered.length === 0 ? (
          <div
            className="empty"
            style={{
              padding: '16px',
              fontSize: 11,
              color: 'var(--text-2)',
            }}
          >
            {search
              ? `No templates match "${search}".`
              : 'No templates yet. Spawn a plan and use Save-as-template on the PlanCard to capture one.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {filtered.map((tpl) => (
              <TemplateCard
                key={tpl.id}
                template={tpl}
                isExpanded={expanded.has(tpl.id)}
                onToggleExpand={() => toggleExpanded(tpl.id)}
                onUse={() => void handleUse(tpl)}
                onDelete={() => setConfirmDeleteId(tpl.id)}
                busy={busyId === tpl.id}
                canUse={!!projectId}
              />
            ))}
          </div>
        )}
      </div>

      {confirmDeleteId &&
        (() => {
          const target = templates?.find((t) => t.id === confirmDeleteId);
          if (!target) return null;
          return (
            <ConfirmDeleteTemplate
              template={target}
              onConfirm={() => void handleDelete(target)}
              onCancel={() => setConfirmDeleteId(null)}
            />
          );
        })()}
    </div>
  );
}

function TemplateCard({
  template,
  isExpanded,
  onToggleExpand,
  onUse,
  onDelete,
  busy,
  canUse,
}: {
  template: Template;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onUse: () => void;
  onDelete: () => void;
  busy: boolean;
  canUse: boolean;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 4,
        background: 'var(--sub-1)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
        }}
      >
        <button
          className="icon-btn"
          onClick={onToggleExpand}
          title={isExpanded ? 'Hide plan' : 'Show plan'}
          style={{ width: 18, height: 18 }}
        >
          {isExpanded ? '▾' : '▸'}
        </button>
        <span style={{ fontWeight: 600, fontSize: 12 }}>{template.name}</span>
        {template.builtin && (
          <span
            className="badge"
            style={{ background: 'var(--sub-2)', color: 'var(--muted)' }}
            title="Built-in template — read-only"
          >
            built-in
          </span>
        )}
        {template.tags.map((t) => (
          <span
            key={t}
            className="badge"
            style={{
              background: 'var(--sub-2)',
              color: 'var(--text-2)',
            }}
          >
            {t}
          </span>
        ))}
        <span
          style={{ color: 'var(--text-2)', fontSize: 11, marginLeft: 4 }}
        >
          {template.rows.length}{' '}
          {template.rows.length === 1 ? 'agent' : 'agents'}
        </span>
        <span className="spacer" />
        {!template.builtin && (
          <button
            className="icon-btn"
            onClick={onDelete}
            disabled={busy}
            title="Delete template"
            style={{ width: 22, height: 22, fontSize: 13 }}
          >
            ×
          </button>
        )}
        <button
          className="tb-btn primary"
          onClick={onUse}
          disabled={busy || !canUse}
          title={
            canUse
              ? 'Inject the template plan into the Director — edit rows before spawning'
              : 'Pick a project first'
          }
          style={{ height: 22 }}
        >
          {busy ? 'Loading…' : 'Use template'}
        </button>
      </div>

      {template.description && (
        <div
          style={{
            padding: '0 12px 8px 38px',
            color: 'var(--text-2)',
            fontSize: 11,
          }}
        >
          {template.description}
        </div>
      )}

      {isExpanded && (
        <div
          style={{
            borderTop: '1px solid var(--border)',
            padding: '6px 12px 10px 12px',
            background: 'var(--sub-2)',
          }}
        >
          {template.rows.map((r, idx) => (
            <TemplateRowView
              key={`${r.name}-${idx}`}
              row={r}
              isLast={idx === template.rows.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateRowView({ row, isLast }: { row: PlanRow; isLast: boolean }) {
  return (
    <div
      className="plan-row"
      style={{ fontSize: 11, padding: '3px 0', alignItems: 'flex-start' }}
    >
      <span className="num">{String(row.i).padStart(2, '0')}</span>
      <span className="tree">{isLast ? '└─' : '├─'}</span>
      <span
        className="who"
        style={{ color: ROLE_TINT[row.role], minWidth: 70 }}
      >
        {row.role}
      </span>
      <span style={{ flex: 1, color: 'var(--text-1)', whiteSpace: 'pre-wrap' }}>
        {row.task}
      </span>
    </div>
  );
}

function ConfirmDeleteTemplate({
  template,
  onConfirm,
  onCancel,
}: {
  template: Template;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 360 }}
      >
        <div className="modal-head">
          <span className="title">
            <b>Delete template?</b>
          </span>
        </div>
        <div className="modal-body" style={{ fontSize: 11 }}>
          <div style={{ marginBottom: 8 }}>
            "{template.name}" will be removed. This can't be undone.
          </div>
          <div style={{ color: 'var(--text-2)' }}>
            Any plans already spawned from this template aren't affected.
          </div>
        </div>
        <div className="modal-foot">
          <button className="tb-btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="tb-btn primary" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
