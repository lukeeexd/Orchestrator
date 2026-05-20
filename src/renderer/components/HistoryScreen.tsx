import { useEffect, useMemo, useState } from 'react';
import type {
  AgentRole,
  AgentStatus,
  HistoryRow,
  PlanRow,
  Project,
} from '../../shared/types';
import { ROLE_TINT, STATUS_TINT } from '../../shared/roles';
import { Icon } from './Icon';
import { SaveTemplateDialog } from './SaveTemplateDialog';

const ROLES_ALL: AgentRole[] = ['pm', 'researcher', 'coder', 'qa', 'devops', 'security'];
const STATUSES_ALL: AgentStatus[] = [
  'running',
  'waiting',
  'approval',
  'paused',
  'done',
  'error',
];

type SortField = 'startedAt' | 'cost' | 'tokens' | 'elapsed';

function fmt$(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}
function fmtRelTime(ts: number): string {
  const diff = Date.now() - ts;
  const day = 24 * 3600 * 1000;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < day) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString();
}

interface Props {
  projects: Project[];
  /** Switch to the agents rail, with this project + agent selected. */
  onOpenAgent: (projectId: string, agentId: string) => void;
}

export function HistoryScreen({ projects, onOpenAgent }: Props) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [reloading, setReloading] = useState(false);

  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [roleFilter, setRoleFilter] = useState<Set<AgentRole>>(new Set());
  const [statusFilter, setStatusFilter] = useState<Set<AgentStatus>>(new Set());
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<SortField>('startedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  /**
   * Open SaveTemplateDialog with this row's role + task captured as a
   * single-row PlanRow[]. Null = closed. Lets the user reuse a one-off
   * task they ran via Save-as-template the same way they would from
   * a PlanCard (P11 — closes the loop on the Templates feature from P1).
   */
  const [saveTemplateContext, setSaveTemplateContext] = useState<{
    rows: PlanRow[];
    prefillName: string;
  } | null>(null);

  const load = async () => {
    setReloading(true);
    try {
      const next = await window.api.listHistory();
      setRows(next);
    } finally {
      setReloading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    const out = rows.filter((r) => {
      if (projectFilter !== 'all' && r.projectId !== projectFilter) return false;
      if (roleFilter.size > 0 && !roleFilter.has(r.role)) return false;
      if (statusFilter.size > 0 && !statusFilter.has(r.status)) return false;
      if (q) {
        const hay = `${r.name} ${r.task} ${r.projectName}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    out.sort((a, b) => {
      const av = a[sortField];
      const bv = b[sortField];
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return out;
  }, [rows, projectFilter, roleFilter, statusFilter, search, sortField, sortDir]);

  const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const flipSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const headerCell = (label: string, field: SortField) => (
    <span
      className="history-cell-num history-sortable"
      onClick={() => flipSort(field)}
      title={`Sort by ${label.toLowerCase()}`}
    >
      {label}
      {sortField === field ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
    </span>
  );

  return (
    <div className="pane settings-pane" style={{ flex: 1 }}>
      <div className="pane-head">
        <span className="title">
          <b>History</b>
        </span>
        <span className="spacer" />
        <button
          className="tb-btn"
          onClick={() => void load()}
          disabled={reloading}
          title="Reload from registry"
        >
          <Icon name="redirect" size={11} /> {reloading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div className="settings-body">
        <section className="settings-section">
          <h3 className="settings-h">Filters</h3>
          <div className="history-filter-row">
            <input
              className="text-input"
              placeholder="Search name, task, project…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ flex: 1, minWidth: 200 }}
            />
            <select
              className="text-input settings-select"
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              style={{ width: 200 }}
            >
              <option value="all">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="history-chip-row">
            <span className="history-chip-label">Roles:</span>
            {ROLES_ALL.map((r) => (
              <button
                key={r}
                className={'role-chip' + (roleFilter.has(r) ? ' on' : '')}
                onClick={() => setRoleFilter((s) => toggle(s, r))}
                style={{
                  borderColor: roleFilter.has(r) ? ROLE_TINT[r] : undefined,
                }}
              >
                <span className="role-tint" style={{ background: ROLE_TINT[r] }} />
                {r}
              </button>
            ))}
            {(roleFilter.size > 0 || statusFilter.size > 0) && (
              <button
                className="tb-btn"
                style={{ marginLeft: 8, height: 20, fontSize: 11 }}
                onClick={() => {
                  setRoleFilter(new Set());
                  setStatusFilter(new Set());
                }}
              >
                Clear filters
              </button>
            )}
          </div>
          <div className="history-chip-row">
            <span className="history-chip-label">Status:</span>
            {STATUSES_ALL.map((s) => (
              <button
                key={s}
                className={'role-chip' + (statusFilter.has(s) ? ' on' : '')}
                onClick={() => setStatusFilter((set) => toggle(set, s))}
                style={{
                  borderColor: statusFilter.has(s)
                    ? STATUS_TINT[s]
                    : undefined,
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h3 className="settings-h">
            {filtered.length} of {rows?.length ?? 0} run
            {(rows?.length ?? 0) === 1 ? '' : 's'}
          </h3>
          {rows && rows.length === 0 ? (
            <div className="inline-empty">
              No agents have been spawned yet. Once you do, every run shows
              up here.
            </div>
          ) : filtered.length === 0 ? (
            <div className="inline-empty">
              No agents match the current filters.
            </div>
          ) : (
            <div className="history-table">
              <div className="history-row history-header">
                <span className="history-cell-label">Agent</span>
                <span className="history-cell-num">Project</span>
                <span className="history-cell-num">Model</span>
                <span className="history-cell-num">Status</span>
                {headerCell('Tokens', 'tokens')}
                {headerCell('Cost', 'cost')}
                {headerCell('Duration', 'elapsed')}
                {headerCell('Started', 'startedAt')}
              </div>
              {filtered.map((r) => (
                <div
                  className="history-row"
                  key={r.id}
                  onClick={() => onOpenAgent(r.projectId, r.id)}
                  title="Open in workspace"
                >
                  <span className="history-cell-label">
                    <span
                      className="role-tint"
                      style={{ background: ROLE_TINT[r.role], marginRight: 6 }}
                    />
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {r.name}
                    </span>
                    <button
                      className="icon-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSaveTemplateContext({
                          rows: [
                            { i: 1, role: r.role, name: r.name, task: r.task },
                          ],
                          prefillName: `${r.role}: ${r.task.slice(0, 60).trim()}${r.task.length > 60 ? '…' : ''}`,
                        });
                      }}
                      title="Save this run's task as a reusable template"
                      style={{
                        width: 18,
                        height: 18,
                        marginLeft: 6,
                        opacity: 0.6,
                      }}
                    >
                      <Icon name="templates" size={11} />
                    </button>
                    {r.forkedFromName && (
                      <span
                        className="badge"
                        style={{
                          background: 'transparent',
                          color: 'var(--muted)',
                          marginLeft: 6,
                          fontSize: 9,
                        }}
                        title={`Forked from @${r.forkedFromName}`}
                      >
                        fork
                      </span>
                    )}
                    {r.spawnedBy === 'director' && !r.forkedFromName && (
                      <span
                        className="badge"
                        style={{
                          background: 'transparent',
                          color: 'var(--muted)',
                          marginLeft: 6,
                          fontSize: 9,
                        }}
                        title="Spawned by Director from an accepted plan"
                      >
                        dir
                      </span>
                    )}
                  </span>
                  <span className="history-cell-num">{r.projectName}</span>
                  <span className="history-cell-num">
                    <code style={{ fontSize: 10 }}>{r.model}</code>
                  </span>
                  <span
                    className="history-cell-num"
                    style={{ color: STATUS_TINT[r.status] ?? 'var(--muted)' }}
                  >
                    {r.statusLabel}
                  </span>
                  <span className="history-cell-num">{fmtTokens(r.tokens)}</span>
                  <span className="history-cell-num">{fmt$(r.cost)}</span>
                  <span className="history-cell-num">{r.elapsed}</span>
                  <span
                    className="history-cell-num"
                    title={new Date(r.startedAt).toLocaleString()}
                  >
                    {fmtRelTime(r.startedAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {saveTemplateContext && (
        <SaveTemplateDialog
          rows={saveTemplateContext.rows}
          mode="auto"
          prefillName={saveTemplateContext.prefillName}
          prefillTags={['runbook', saveTemplateContext.rows[0].role]}
          onCancel={() => setSaveTemplateContext(null)}
          onSave={async (input) => {
            const created = await window.api.createTemplate({
              name: input.name,
              description: input.description,
              mode: input.mode,
              tags: input.tags,
              rows: saveTemplateContext.rows,
            });
            setSaveTemplateContext(null);
            return created;
          }}
        />
      )}
    </div>
  );
}
