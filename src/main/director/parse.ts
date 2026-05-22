import type {
  PlanRow,
  AgentRole,
  Provider,
  ProjectPrd,
  RedirectInstruction,
} from '../../shared/types';

const VALID_ROLES: AgentRole[] = [
  'pm',
  'researcher',
  'coder',
  'qa',
  'devops',
  'security',
];

const VALID_PROVIDERS: Provider[] = ['claude', 'codex'];

interface ParseResult {
  /** Text with all orchestrator blocks stripped. */
  text: string;
  /** Parsed plan rows, if a valid plan block was found. */
  plan: PlanRow[] | null;
  /** Parsed redirect, if a valid redirect block was found. */
  redirect: RedirectInstruction | null;
  /** P15: Parsed PRD, if a valid `orchestrator-prd` block was found. */
  prd: ProjectPrd | null;
}

const PLAN_RE = /```orchestrator-plan\s*\n([\s\S]*?)\n```/i;
const REDIRECT_RE = /```orchestrator-redirect\s*\n([\s\S]*?)\n```/i;
const PRD_RE = /```orchestrator-prd\s*\n([\s\S]*?)\n```/i;

function parsePlan(raw: string): PlanRow[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
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
    // Optional provider override. Drop anything that isn't one of the
    // known values — never let a typo'd "Anthropic" or "openai" silently
    // pass through and confuse the runner's CLI dispatch.
    const provider =
      typeof r.provider === 'string' &&
      VALID_PROVIDERS.includes(r.provider as Provider)
        ? (r.provider as Provider)
        : undefined;
    rows.push({
      i: r.i,
      role: r.role as AgentRole,
      name: r.name,
      task: r.task,
      ...(provider ? { provider } : {}),
    });
  }
  return rows.length > 0 ? rows : null;
}

/**
 * Parse the JSON body of an `orchestrator-prd` block. Required fields
 * are `problem` (non-empty string) + at least one of the four list
 * sections. Missing list fields default to `[]` so the renderer can
 * iterate without null-checks; the Director is encouraged to emit
 * every section but we don't fail-closed on omissions.
 */
function parsePrd(raw: string): ProjectPrd | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object') return null;
  const r = parsed as Record<string, unknown>;
  const problem = typeof r.problem === 'string' ? r.problem.trim() : '';
  if (!problem) return null;
  const stringArray = (key: string): string[] => {
    const v = r[key];
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const item of v) {
      if (typeof item === 'string' && item.trim()) out.push(item.trim());
    }
    return out;
  };
  const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : undefined;
  const goals = stringArray('goals');
  const non_goals = stringArray('non_goals');
  const constraints = stringArray('constraints');
  const open_questions = stringArray('open_questions');
  if (
    goals.length === 0 &&
    non_goals.length === 0 &&
    constraints.length === 0 &&
    open_questions.length === 0
  ) {
    return null;
  }
  return {
    ...(title ? { title } : {}),
    problem,
    goals,
    non_goals,
    constraints,
    open_questions,
  };
}

function parseRedirect(raw: string): RedirectInstruction | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object') return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r.agent !== 'string' || !r.agent.trim()) return null;
  if (typeof r.instruction !== 'string' || !r.instruction.trim()) return null;
  return { agent: r.agent.trim(), instruction: r.instruction.trim() };
}

/**
 * Scan an assistant text block for fenced `orchestrator-plan` and
 * `orchestrator-redirect` blocks. Extract + validate each, return both
 * the stripped text and the parsed payloads. Either field is null if
 * not present or malformed; the original text is returned verbatim
 * when nothing matches.
 */
export function extractDirectives(body: string): ParseResult {
  let text = body;
  let plan: PlanRow[] | null = null;
  let redirect: RedirectInstruction | null = null;
  let prd: ProjectPrd | null = null;

  const planMatch = PLAN_RE.exec(body);
  if (planMatch) {
    const parsed = parsePlan(planMatch[1].trim());
    if (parsed) {
      plan = parsed;
      text = text.replace(PLAN_RE, '');
    }
  }

  const redirectMatch = REDIRECT_RE.exec(text);
  if (redirectMatch) {
    const parsed = parseRedirect(redirectMatch[1].trim());
    if (parsed) {
      redirect = parsed;
      text = text.replace(REDIRECT_RE, '');
    }
  }

  const prdMatch = PRD_RE.exec(text);
  if (prdMatch) {
    const parsed = parsePrd(prdMatch[1].trim());
    if (parsed) {
      prd = parsed;
      text = text.replace(PRD_RE, '');
    }
  }

  return { text: text.trim(), plan, redirect, prd };
}

/** @deprecated Use `extractDirectives` — keeps the old single-purpose name working. */
export function extractPlan(body: string): { text: string; plan: PlanRow[] | null } {
  const r = extractDirectives(body);
  return { text: r.text, plan: r.plan };
}
