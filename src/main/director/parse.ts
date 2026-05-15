import type { PlanRow, AgentRole } from '../../shared/types';

const VALID_ROLES: AgentRole[] = ['pm', 'researcher', 'coder', 'qa', 'devops'];

interface ParseResult {
  /** Text with the plan code block stripped out. */
  text: string;
  /** Parsed plan rows, if a valid block was found. */
  plan: PlanRow[] | null;
}

const PLAN_RE = /```orchestrator-plan\s*\n([\s\S]*?)\n```/i;

/**
 * Scan an assistant text block for a fenced ```orchestrator-plan``` block,
 * extract + validate the JSON, and return both the stripped text and the
 * parsed PlanRow[]. If no block (or malformed JSON), returns the original
 * text and plan=null.
 */
export function extractPlan(body: string): ParseResult {
  const match = PLAN_RE.exec(body);
  if (!match) return { text: body, plan: null };

  const raw = match[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { text: body, plan: null };
  }
  if (!Array.isArray(parsed)) return { text: body, plan: null };

  const rows: PlanRow[] = [];
  for (const item of parsed) {
    if (item == null || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.i !== 'number') continue;
    if (typeof r.role !== 'string' || !VALID_ROLES.includes(r.role as AgentRole)) {
      continue;
    }
    if (typeof r.name !== 'string') continue;
    if (typeof r.task !== 'string') continue;
    rows.push({
      i: r.i,
      role: r.role as AgentRole,
      name: r.name,
      task: r.task,
    });
  }
  if (rows.length === 0) return { text: body, plan: null };

  const text = body.replace(PLAN_RE, '').trim();
  return { text, plan: rows };
}
