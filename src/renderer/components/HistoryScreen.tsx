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
import { HistoryTimeline } from './HistoryTimeline';

/**
 * P12 — Changelog generator prompt. Researcher walks recent git state
 * in the workspace and produces a single CHANGELOG.md entry. We don't
 * try to detect the project's existing changelog style client-side —
 * the agent is asked to READ the file (if any) and match it.
 */
function buildChangelogPrompt(): string {
  return (
    `Produce a CHANGELOG.md entry for the recent work in this workspace.\n\n` +
    `Steps:\n` +
    `1. Run \`git log --since="14 days ago" --pretty="%h %s" --no-merges\` ` +
    `to see recent commits.\n` +
    `2. Run \`git diff HEAD~10..HEAD --stat\` (or fewer commits if the ` +
    `repo is younger) to see file-level scope.\n` +
    `3. If a CHANGELOG.md already exists at the workspace root, READ ` +
    `it and match its formatting + heading style. Otherwise default to ` +
    `Keep-a-Changelog form.\n` +
    `4. Produce ONE entry covering the recent work. Group bullets by ` +
    `theme (features / fixes / refactors). Two to six bullets, terse. ` +
    `Lead with the WHY where it's non-obvious.\n\n` +
    `Output: the markdown entry as your final result. Do NOT modify ` +
    `CHANGELOG.md — the user wants to paste it themselves.`
  );
}

/**
 * P16 — Session recap prompt. Researcher turns ONE agent row's task
 * + result into a narrative recap suitable for a PR description or
 * teammate Slack. Context is baked into the prompt so the researcher
 * doesn't have to chase the source agent's session id (which lives
 * in a different CLI session anyway).
 */
function buildRecapPrompt(row: HistoryRow): string {
  const truncate = (s: string, n: number) =>
    s.length > n ? s.slice(0, n) + '…' : s;
  return (
    `Produce a narrative recap of a recent agent run.\n\n` +
    `The run:\n` +
    `- Agent: ${row.name}\n` +
    `- Role: ${row.roleLabel} (${row.role})\n` +
    `- Status: ${row.statusLabel}\n` +
    `- Tokens: ${row.tokens.toLocaleString()} · Cost: $${row.cost.toFixed(2)} · ` +
    `Duration: ${row.elapsed}\n\n` +
    `Original task (verbatim):\n` +
    `> ${truncate(row.task, 1200).replace(/\n/g, '\n> ')}\n\n` +
    `Write a three-paragraph recap as your final result:\n` +
    `  Para 1: What the agent set out to do (one sentence, no fluff).\n` +
    `  Para 2: What it actually did — files touched, decisions made, ` +
    `commands run. Two to four concrete sentences. If git state is ` +
    `accessible from the workspace, cross-check claims against it.\n` +
    `  Para 3: Loose ends, follow-ups, or anything the user should ` +
    `verify before treating the work as done. One or two sentences.\n\n` +
    `Tone: tight, terminal voice. No emoji. Write in the third person ` +
    `about the work itself, not "the agent did X". Output ONLY the ` +
    `three paragraphs.`
  );
}

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
  // F8: list / timeline view-mode toggle. List is the existing table;
  // timeline renders the filtered rows as a Gantt-style chart.
  const [viewMode, setViewMode] = useState<'list' | 'timeline'>('list');
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
  /**
   * P12 + P16 — Tracks an in-flight distill spawn so we can disable
   * the row's buttons during the round-trip. Keyed by (rowId, kind)
   * so a "changelog" click can't briefly tick the "recap" busy state
   * on the same row.
   */
  const [distilling, setDistilling] = useState<
    { rowId: string; kind: 'changelog' | 'recap' } | null
  >(null);

  /**
   * P12 + P16 — Spawn a one-shot researcher with a tailored prompt
   * and, on success, navigate the user to the new agent so they see
   * the result. The workspace comes from the source row's project so
   * the spawn lands in the right tree (the row may be from a project
   * that's not currently active).
   */
  const spawnDistiller = async (
    row: HistoryRow,
    kind: 'changelog' | 'recap',
  ): Promise<void> => {
    const project = projects.find((p) => p.id === row.projectId);
    if (!project || !project.workspace) return;
    setDistilling({ rowId: row.id, kind });
    try {
      const task =
        kind === 'changelog' ? buildChangelogPrompt() : buildRecapPrompt(row);
      const res = await window.api.spawnAgent({
        projectId: row.projectId,
        role: 'researcher',
        workspace: project.workspace,
        task,
      });
      onOpenAgent(row.projectId, res.agentId);
    } catch (e) {
      // Spawn errors are rare (security guard / cli missing) — surface
      // them via console; the user is about to switch screens so a
      // toast would be lost mid-transition anyway.
      console.error('[history] distiller spawn failed:', e);
    } finally {
      setDistilling(null);
    }
  };

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
        <div
          className="mode-toggle"
          style={{ marginLeft: 12 }}
          title="List shows the full sortable table. Timeline renders the same rows as a Gantt-style chart over wall-clock time."
        >
          <button
            className={viewMode === 'list' ? 'on' : ''}
            onClick={() => setViewMode('list')}
          >
            list
          </button>
          <button
            className={viewMode === 'timeline' ? 'on' : ''}
            onClick={() => setViewMode('timeline')}
          >
            timeline
          </button>
        </div>
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
          ) : viewMode === 'timeline' ? (
            <HistoryTimeline rows={filtered} onOpenAgent={onOpenAgent} />
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
                      style={{ width: 22, height: 22, marginLeft: 6 }}
                    >
                      <Icon name="templates" size={13} />
                    </button>
                    {/* P12 — generate a CHANGELOG.md entry from recent git state. */}
                    <button
                      className="icon-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        void spawnDistiller(r, 'changelog');
                      }}
                      disabled={
                        distilling?.rowId === r.id &&
                        distilling.kind === 'changelog'
                      }
                      title="Generate a CHANGELOG.md entry from recent workspace git state (spawns a one-shot researcher)"
                      style={{ width: 22, height: 22, marginLeft: 2 }}
                    >
                      <Icon name="file" size={13} />
                    </button>
                    {/* P16 — narrative recap of this row's run. */}
                    <button
                      className="icon-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        void spawnDistiller(r, 'recap');
                      }}
                      disabled={
                        distilling?.rowId === r.id &&
                        distilling.kind === 'recap'
                      }
                      title="Generate a 3-paragraph recap of this run (spawns a one-shot researcher with the task + result already in its prompt)"
                      style={{ width: 22, height: 22, marginLeft: 2 }}
                    >
                      <Icon name="logs" size={13} />
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
