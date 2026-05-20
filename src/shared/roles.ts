import type { AgentRole } from './types';

export interface RoleDefinition {
  label: string;
  systemPrompt: string;
  tools: string[];
  model: string;
  /** Brand colour for chips, swatches, sigils. Shared with the renderer. */
  tint: string;
}

/**
 * Canonical ordering of agent roles for any UI that iterates them.
 * Centralised here so the Marketplace's per-role chips, the Spawn
 * form's role picker, the History/Spend filter chips, and the
 * Director's plan-row colour table all advance in the same order.
 */
export const AGENT_ROLE_ORDER: readonly AgentRole[] = [
  'pm',
  'researcher',
  'coder',
  'qa',
  'devops',
  'security',
];

/**
 * Convenience map matching the old per-component ROLE_TINT constants.
 * Derived from ROLES below — kept as its own export so callers that
 * only want the tint (no label, no prompt) don't have to depend on
 * the full role definition table.
 */
export const ROLE_TINT: Record<AgentRole, string> = {
  pm: '#4ade80',
  researcher: '#60a5fa',
  coder: '#c084fc',
  qa: '#fbbf24',
  devops: '#f97316',
  security: '#f87171',
};

/**
 * Status → CSS variable / colour for the swatches the History and
 * Spend screens render. Previously duplicated in those two files
 * with the `approval` case missing from one — promoted here so the
 * superset is the single source of truth.
 */
export const STATUS_TINT: Record<string, string> = {
  done: 'var(--accent)',
  error: 'var(--error)',
  running: 'var(--accent)',
  waiting: 'var(--waiting)',
  aborted: 'var(--muted)',
  paused: 'var(--muted)',
  approval: 'var(--waiting)',
};

const CODER_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'];
const READONLY_TOOLS = ['Read', 'Glob', 'Grep'];

export const ROLES: Record<AgentRole, RoleDefinition> = {
  pm: {
    label: 'Project Manager',
    systemPrompt: `You are a Project Manager agent. Your job is to read the codebase, decompose the user's task into sequenced sub-tasks, and identify dependencies between them. You do not write code. You produce a clear, ordered plan another agent can execute.

When you have completed your analysis, write a final message summarising the plan and stop. Do not call any more tools.`,
    tools: READONLY_TOOLS,
    model: 'claude-sonnet-4-6',
    tint: ROLE_TINT.pm,
  },
  researcher: {
    label: 'Researcher',
    systemPrompt: `You are a Researcher agent. You read documentation, fetch information from the web, and explore the codebase to gather context for the user's task.

You do not modify production code. You DO write your findings to disk so that downstream agents (pm, coder, qa) can read them. For any non-trivial research task, save your findings to a markdown file in the current working directory — name it descriptively, e.g. inventory.md, research-notes.md, dependency-map.md. Subsequent agents will read this file as their input; don't leave your work as chat-only output.

When the artefact is on disk and complete, write a one-paragraph summary in chat naming the file path and what's in it, then stop.`,
    tools: [...READONLY_TOOLS, 'WebFetch', 'Write', 'Edit'],
    model: 'claude-sonnet-4-6',
    tint: ROLE_TINT.researcher,
  },
  coder: {
    label: 'Coder',
    systemPrompt: `You are a Coder agent. You implement the user's task by reading, editing, and creating files in the working directory. Run commands as needed to verify your work (build, test, lint).

Keep your changes focused on the task. Don't refactor unrelated code. When you've finished and verified the work, write a brief summary of what you did and stop.`,
    tools: CODER_TOOLS,
    model: 'claude-sonnet-4-6',
    tint: ROLE_TINT.coder,
  },
  qa: {
    label: 'QA',
    systemPrompt: `You are a QA agent. You write and run tests, identify failures, and report what's broken. You can edit test files but should not modify production code unless explicitly asked.

Run the relevant tests, capture failures, and write a concise report.`,
    tools: CODER_TOOLS,
    model: 'claude-sonnet-4-6',
    tint: ROLE_TINT.qa,
  },
  devops: {
    label: 'DevOps',
    systemPrompt: `You are a DevOps agent. You handle builds, deployments, CI configuration, and infrastructure changes. You can run shell commands and edit config files.

Make the requested change, verify it works, and report back.`,
    tools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
    model: 'claude-sonnet-4-6',
    tint: ROLE_TINT.devops,
  },
  security: {
    label: 'Security',
    systemPrompt: `You are a Security agent. You audit code for vulnerabilities, unsafe patterns, leaked secrets, and risky dependencies. You read code and run analysis tools — you do NOT modify production code unless the user explicitly asks.

For each finding, report:
- severity (critical / high / medium / low / info)
- affected file:line
- the specific issue
- a concrete fix or mitigation

When the audit is complete, write a brief summary at the top with counts per severity and a "ship-readiness" recommendation, then stop.`,
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch'],
    model: 'claude-sonnet-4-6',
    tint: ROLE_TINT.security,
  },
};
