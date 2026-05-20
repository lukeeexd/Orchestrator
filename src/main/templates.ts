import { randomUUID } from 'node:crypto';
import { getDb, scheduleSave } from './db';
import { saveDirectorMessage } from './persistence';
import type {
  DirectorMessage,
  PlanRow,
  Template,
  DirectorMode,
} from '../shared/types';

function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asInt(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : fallback;
}

function parseTags(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item === 'string' && item.length > 0) out.push(item);
    }
    return out;
  } catch {
    return [];
  }
}

function parseRows(raw: unknown): PlanRow[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Defensive: keep only entries that look like a PlanRow. Anything
    // missing the required fields is dropped silently — better than
    // surfacing a malformed row into the PlanCard.
    const out: PlanRow[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      if (typeof r.i !== 'number') continue;
      if (typeof r.role !== 'string') continue;
      if (typeof r.name !== 'string') continue;
      if (typeof r.task !== 'string') continue;
      out.push({
        i: r.i,
        role: r.role as PlanRow['role'],
        name: r.name,
        task: r.task,
        ...(typeof r.provider === 'string'
          ? { provider: r.provider as PlanRow['provider'] }
          : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

function rowFromDb(row: ReadonlyArray<unknown>): Template {
  return {
    id: asStr(row[0]),
    name: asStr(row[1]),
    description: asStr(row[2]),
    mode: (asStr(row[3], 'auto') === 'manual' ? 'manual' : 'auto') as DirectorMode,
    tags: parseTags(row[4]),
    rows: parseRows(row[5]),
    builtin: asInt(row[6]) === 1,
    createdAt: asInt(row[7]),
    updatedAt: asInt(row[8]),
  };
}

export function listTemplates(): Template[] {
  const db = getDb();
  const stmt = db.prepare(
    `SELECT id, name, description, mode, tags, rows_json, builtin, created_at, updated_at
     FROM templates
     ORDER BY builtin DESC, name COLLATE NOCASE ASC`,
  );
  const out: Template[] = [];
  while (stmt.step()) out.push(rowFromDb(stmt.get()));
  stmt.free();
  return out;
}

export function getTemplate(id: string): Template | null {
  const db = getDb();
  const stmt = db.prepare(
    `SELECT id, name, description, mode, tags, rows_json, builtin, created_at, updated_at
     FROM templates WHERE id = ?`,
  );
  stmt.bind([id]);
  const row = stmt.step() ? rowFromDb(stmt.get()) : null;
  stmt.free();
  return row;
}

export interface CreateTemplateInput {
  name: string;
  description?: string;
  mode?: DirectorMode;
  tags?: string[];
  rows: PlanRow[];
}

export function createTemplate(input: CreateTemplateInput): Template {
  const now = Date.now();
  const id = randomUUID();
  const tpl: Template = {
    id,
    name: input.name,
    description: input.description ?? '',
    mode: input.mode ?? 'auto',
    tags: input.tags ?? [],
    rows: input.rows,
    builtin: false,
    createdAt: now,
    updatedAt: now,
  };
  insertOrReplace(tpl);
  return tpl;
}

export interface UpdateTemplateInput {
  name?: string;
  description?: string;
  mode?: DirectorMode;
  tags?: string[];
  rows?: PlanRow[];
}

export function updateTemplate(
  id: string,
  patch: UpdateTemplateInput,
): Template | null {
  const existing = getTemplate(id);
  if (!existing) return null;
  // Built-ins are read-only — the renderer hides the affordance, but we
  // also defend at the data layer in case an old client bypasses it.
  if (existing.builtin) return existing;
  const next: Template = {
    ...existing,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined
      ? { description: patch.description }
      : {}),
    ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    ...(patch.rows !== undefined ? { rows: patch.rows } : {}),
    updatedAt: Date.now(),
  };
  insertOrReplace(next);
  return next;
}

export function deleteTemplate(id: string): boolean {
  const existing = getTemplate(id);
  if (!existing) return false;
  if (existing.builtin) return false; // builtins are protected
  const db = getDb();
  const stmt = db.prepare(`DELETE FROM templates WHERE id = ?`);
  stmt.run([id]);
  stmt.free();
  scheduleSave();
  return true;
}

function insertOrReplace(tpl: Template): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO templates
       (id, name, description, mode, tags, rows_json, builtin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run([
    tpl.id,
    tpl.name,
    tpl.description,
    tpl.mode,
    JSON.stringify(tpl.tags),
    JSON.stringify(tpl.rows),
    tpl.builtin ? 1 : 0,
    tpl.createdAt,
    tpl.updatedAt,
  ]);
  stmt.free();
  scheduleSave();
}

/**
 * Synthesise a Director message carrying a template's plan rows into a
 * project's chat. The renderer's existing handler for messages with a
 * non-empty `plan` field surfaces the editable PlanCard automatically —
 * the user gets the same drop/edit/spawn UX they would for a
 * Director-emitted plan, without having to round-trip through a
 * planning turn.
 *
 * The message body explicitly names the template so the chat history
 * records which template the user picked (useful for the Save-as-runbook
 * follow-up in BACKLOG.md P11).
 */
export function useTemplate(
  projectId: string,
  templateId: string,
): DirectorMessage | null {
  const tpl = getTemplate(templateId);
  if (!tpl) return null;
  // Renumber `i` defensively in case the stored rows were saved with
  // gaps (e.g. a Save-as-template captured a plan after the user
  // dropped row 2 of 4). PlanCard relies on `i` for the leading 00/01
  // numbering and the user shouldn't see "01, 03, 04".
  const renumbered: PlanRow[] = tpl.rows.map((r, idx) => ({
    ...r,
    i: idx + 1,
  }));
  const message: DirectorMessage = {
    id: randomUUID(),
    projectId,
    who: 'director',
    name: 'Director',
    time: new Date().toISOString(),
    body: `Loaded template **${tpl.name}**. Edit any row below, drop ones you don't want, then click Spawn.`,
    plan: renumbered,
    planAccepted: false,
    live: false,
  };
  saveDirectorMessage(message);
  return message;
}

// ─────────────────────────── Built-in seed templates ───────────────────────────

const BUILTIN_TEMPLATES: ReadonlyArray<{
  id: string;
  name: string;
  description: string;
  mode: DirectorMode;
  tags: string[];
  rows: PlanRow[];
}> = [
  {
    id: 'builtin-ship-a-feature',
    name: 'Ship a feature',
    description:
      'Decompose → implement → test → confirm. The default fleet for adding a new capability end-to-end.',
    mode: 'auto',
    tags: ['feature', 'fullstack'],
    rows: [
      {
        i: 1,
        role: 'pm',
        name: 'plan',
        task: 'Decompose the feature into the smallest concrete coder + qa tasks. Surface dependencies, risks, and any missing decisions the user should make before implementation starts.',
      },
      {
        i: 2,
        role: 'coder',
        name: 'implement',
        task: 'Implement the plan from the pm step. Make focused commits, keep changes scoped to the named files, and stop if a decision needs the user.',
      },
      {
        i: 3,
        role: 'qa',
        name: 'verify',
        task: 'Run the test suite, exercise the new feature against its golden path, and check at least one edge case. Report exactly what was verified and what was not.',
      },
    ],
  },
  {
    id: 'builtin-tdd-bug-fix',
    name: 'TDD bug fix',
    description:
      'Reproduce with a failing test first, fix until green. Keeps the regression covered.',
    mode: 'auto',
    tags: ['bug', 'tdd', 'tests'],
    rows: [
      {
        i: 1,
        role: 'qa',
        name: 'reproduce',
        task: 'Write a failing test that reproduces the reported bug. Pin the test under the appropriate test directory and confirm it fails for the right reason before handing off.',
      },
      {
        i: 2,
        role: 'coder',
        name: 'fix',
        task: 'Read the failing test from the qa step, fix the underlying defect, and confirm the test passes. Keep the diff minimal — no opportunistic refactors in the same commit.',
      },
      {
        i: 3,
        role: 'qa',
        name: 'confirm',
        task: 'Re-run the full test suite (not just the new test) to confirm the fix did not regress anything else. Report pass/fail counts.',
      },
    ],
  },
  {
    id: 'builtin-security-audit',
    name: 'Security audit',
    description:
      'Audit recent changes for secrets, unsafe patterns, and known-vuln intros. Pairs well with the security role.',
    mode: 'auto',
    tags: ['security', 'audit'],
    rows: [
      {
        i: 1,
        role: 'security',
        name: 'audit',
        task: 'Audit the working tree for hardcoded secrets, unsafe shell-exec / SQL patterns, missing input validation at trust boundaries, and any newly-introduced dependencies with known CVEs. Output findings as a markdown list ranked by severity.',
      },
      {
        i: 2,
        role: 'coder',
        name: 'remediate',
        task: 'Remediate every Critical and High finding from the security audit. Skip Mediums and Lows — those need user prioritisation. Annotate each fix with which finding it addresses.',
      },
      {
        i: 3,
        role: 'security',
        name: 'verify',
        task: 'Re-audit the remediated changes. Confirm each Critical/High finding from the previous audit is now resolved. Report any residual or newly-introduced issues.',
      },
    ],
  },
  {
    id: 'builtin-codebase-onboarding',
    name: 'Codebase onboarding',
    description:
      'A single researcher pass that produces a WORKSPACE.md summarising the project layout. Useful for inherited or unfamiliar codebases.',
    mode: 'auto',
    tags: ['onboarding', 'research'],
    rows: [
      {
        i: 1,
        role: 'researcher',
        name: 'map',
        task: 'Walk the project root and produce a WORKSPACE.md at the workspace root (~150 lines). Cover: top-level layout, build/test/run commands, primary entry points, notable conventions, and any LOAD-BEARING decisions captured in PLAN.md / CLAUDE.md / README.md. Do not modify any other files.',
      },
    ],
  },
];

/**
 * Idempotent seed of the built-in templates. Called on startup.
 * INSERT OR IGNORE keeps the seed safe across hot restarts: rows
 * already present (from a previous boot, or from the v20 migration on
 * an existing DB) are left untouched. Built-ins are also protected
 * from `deleteTemplate`, so the only path to a missing row is a fresh
 * install / first run after migration — both of which want the seed
 * to land.
 *
 * If a future change to a built-in needs to ship (e.g. tweaking the
 * coder prompt), bump that template's `id` — a fresh seed row appears
 * and the old one stays put as if user-authored. Deliberate: it
 * preserves whatever the user might have come to rely on.
 */
export function seedBuiltins(): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO templates
       (id, name, description, mode, tags, rows_json, builtin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  const now = Date.now();
  for (const t of BUILTIN_TEMPLATES) {
    stmt.run([
      t.id,
      t.name,
      t.description,
      t.mode,
      JSON.stringify(t.tags),
      JSON.stringify(t.rows),
      now,
      now,
    ]);
  }
  stmt.free();
  scheduleSave();
}
