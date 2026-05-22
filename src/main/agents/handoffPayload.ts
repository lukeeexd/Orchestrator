import path from 'node:path';
import type {
  Agent,
  HandoffPayload,
  LogLine,
  TestsRunSummary,
  ToolCall,
} from '../../shared/types';

/**
 * Build a HandoffPayload from an agent's accumulated log + the CLI's
 * final result message. Called when the agent's `result` event fires;
 * the result becomes the prose `summary`, and we parse the log for
 * structured evidence (files touched, test counts, TODO surfaces,
 * errors).
 *
 * Heuristic parsing — none of the agent CLIs emit a structured "what
 * I did" payload, so we rely on patterns observed across real runs.
 * Each field falls back safely (empty array, null) when inference
 * isn't possible, so the JSON shape stays stable and the Director's
 * parser doesn't have to handle holes.
 */
export function buildHandoffPayload(
  agent: Agent,
  summary: string,
): HandoffPayload {
  return {
    summary,
    files_touched: extractFilesTouched(agent.log, agent.workspace),
    tests_run: extractTestsRun(agent.log),
    todos: extractTodos(agent.log),
    errors: extractErrors(agent.log),
  };
}

// ─────────────────────────── files_touched ───────────────────────────

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PATH_ARG_KEYS = new Set(['file_path', 'path', 'notebook_path']);

/**
 * Files the agent wrote to or edited. Pulled from tool_use events for
 * Write / Edit / MultiEdit / NotebookEdit — each surfaces the path
 * under one of the standard arg keys. Read-only tools (Read, Glob,
 * Grep) are deliberately excluded; "touched" means the file has new
 * bytes, not just that the agent looked at it.
 *
 * Paths are normalized to workspace-relative when possible so the
 * Director's reasoning isn't sensitive to absolute path differences
 * between dev machines.
 */
function extractFilesTouched(log: LogLine[], workspace: string): string[] {
  const out = new Set<string>();
  for (const line of log) {
    if (line.kind !== 'tool') continue;
    const tool = line.msg as ToolCall;
    if (!WRITE_TOOLS.has(tool.fn)) continue;
    for (const arg of tool.args) {
      if (!PATH_ARG_KEYS.has(arg.k)) continue;
      const normalized = toWorkspaceRelative(arg.v, workspace);
      if (normalized) out.add(normalized);
    }
  }
  return Array.from(out);
}

function toWorkspaceRelative(raw: string, workspace: string): string {
  if (!raw) return '';
  // The arg-truncation in classifier.ts caps very long strings — paths
  // rarely hit that cap but defend anyway.
  const cleaned = raw.replace(/\.\.\.$/u, '');
  if (!workspace) return cleaned;
  try {
    const rel = path.relative(workspace, cleaned);
    // path.relative returns ../ paths when the input is outside the
    // workspace. Keep those as the absolute form so the Director
    // doesn't see misleading ../../ prefixes.
    if (rel.startsWith('..')) return cleaned;
    return rel.replace(/\\/g, '/');
  } catch {
    return cleaned;
  }
}

// ───────────────────────────── tests_run ─────────────────────────────

/**
 * Best-effort test-result extraction. Scans tool_result strings for
 * the most common test-runner output patterns and returns the largest
 * tally we find (a single run with the highest total wins — captures
 * "the real test suite, not a one-test smoke check"). Returns null
 * when no recognised pattern matches.
 *
 * Patterns covered: pytest (`12 passed, 3 failed, 1 skipped`), jest
 * (`Tests:  3 failed, 12 passed, 15 total`), vitest (similar shape),
 * go test (`PASS` lines + `--- FAIL`). Each is matched
 * case-insensitively over the line; partial matches default missing
 * counts to 0.
 */
function extractTestsRun(log: LogLine[]): TestsRunSummary | null {
  let best: TestsRunSummary | null = null;
  const consider = (summary: TestsRunSummary): void => {
    const total = summary.pass + summary.fail + summary.skip;
    if (total === 0) return;
    const bestTotal = best
      ? best.pass + best.fail + best.skip
      : -1;
    if (total > bestTotal) best = summary;
  };
  for (const line of log) {
    if (line.kind !== 'result' && line.kind !== 'thought') continue;
    const text = typeof line.msg === 'string' ? line.msg : '';
    if (!text) continue;

    // pytest: "12 passed, 3 failed, 1 skipped" (any order, optional "in N.NNs").
    // The lazy `.*?` lives INSIDE the optional skipped group so the engine
    // backtracks into matching it instead of bailing out happily with the
    // optional group skipped.
    const pyt = /(\d+)\s+passed.*?(\d+)\s+failed(?:.*?(\d+)\s+skipped)?/i.exec(
      text,
    );
    if (pyt) {
      consider({
        pass: Number(pyt[1]) || 0,
        fail: Number(pyt[2]) || 0,
        skip: Number(pyt[3] ?? 0) || 0,
      });
      continue;
    }
    // pytest-style "X passed" only (all green run)
    const pytPass = /(\d+)\s+passed(?:\s+in\s+[\d.]+s)?\s*$/im.exec(text);
    if (pytPass) {
      consider({ pass: Number(pytPass[1]), fail: 0, skip: 0 });
      continue;
    }
    // jest/vitest emits "Tests: ..." with pass / fail / skip counts in
    // any order — "3 failed, 12 passed" is just as common as
    // "12 passed, 3 failed". Look each count up independently so we
    // don't lose a count to ordering.
    if (/^tests?:/im.test(text)) {
      const p = /(\d+)\s+passed/i.exec(text);
      const f = /(\d+)\s+failed/i.exec(text);
      const s = /(\d+)\s+skipped/i.exec(text);
      if (p || f) {
        consider({
          pass: p ? Number(p[1]) : 0,
          fail: f ? Number(f[1]) : 0,
          skip: s ? Number(s[1]) : 0,
        });
        continue;
      }
    }
    // go test: count PASS / FAIL / SKIP marker lines
    if (/^(?:PASS|FAIL|SKIP)\b/m.test(text)) {
      const pass = (text.match(/^PASS\b/gm) ?? []).length;
      const fail = (text.match(/^FAIL\b/gm) ?? []).length;
      const skip = (text.match(/^SKIP\b/gm) ?? []).length;
      consider({ pass, fail, skip });
    }
  }
  return best;
}

// ─────────────────────────────── todos ───────────────────────────────

const TODO_PREFIXES = [
  /^TODO[:\s]/i,
  /^Next step[:\s]/i,
  /^Follow[- ]up[:\s]/i,
  /^Outstanding[:\s]/i,
  /^Remaining[:\s]/i,
];
const MAX_TODOS = 5;
const TODO_MAX_LEN = 200;

/**
 * Pull TODO / next-step / follow-up surfaces out of the agent's
 * thought log. Matches on common prefixes; one entry per matching
 * line, capped at 5 to keep the JSON readable. Each entry is
 * truncated to 200 chars so a long TODO paragraph doesn't bloat the
 * handoff body.
 */
function extractTodos(log: LogLine[]): string[] {
  const out: string[] = [];
  for (const line of log) {
    if (line.kind !== 'thought') continue;
    const text = typeof line.msg === 'string' ? line.msg : '';
    for (const rawLine of text.split(/\r?\n/)) {
      const trimmed = rawLine.trim().replace(/^[-*]\s+/, '');
      if (!TODO_PREFIXES.some((re) => re.test(trimmed))) continue;
      const cleaned =
        trimmed.length > TODO_MAX_LEN
          ? trimmed.slice(0, TODO_MAX_LEN) + '…'
          : trimmed;
      if (!out.includes(cleaned)) out.push(cleaned);
      if (out.length >= MAX_TODOS) return out;
    }
  }
  return out;
}

// ─────────────────────────────── errors ──────────────────────────────

const MAX_ERRORS = 5;
const ERROR_MAX_LEN = 280;

/**
 * Errors and warnings logged during the run. Kept brief — the Director
 * doesn't need stack traces here, just enough to know "something went
 * wrong and here's the first line".
 */
function extractErrors(log: LogLine[]): string[] {
  const out: string[] = [];
  for (const line of log) {
    if (line.kind !== 'error' && line.kind !== 'warn') continue;
    const text = typeof line.msg === 'string' ? line.msg : '';
    if (!text) continue;
    const firstLine = text.split(/\r?\n/, 1)[0].trim();
    if (!firstLine) continue;
    const cleaned =
      firstLine.length > ERROR_MAX_LEN
        ? firstLine.slice(0, ERROR_MAX_LEN) + '…'
        : firstLine;
    if (!out.includes(cleaned)) out.push(cleaned);
    if (out.length >= MAX_ERRORS) break;
  }
  return out;
}
