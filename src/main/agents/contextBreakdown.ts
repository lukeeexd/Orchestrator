import type {
  ContextBreakdown,
  ContextBreakdownRequest,
  ContextNote,
  ContextSegment,
} from '../../shared/types';
import { ROLES } from '../../shared/roles';
import { estimateTokens, modelContextTokens } from '../../shared/models';
import { readSkill } from '../skills';
import { loadClaudeCodeMemorySection } from '../claudeCodeMemory';
import { getProject, getMcpConfigPath } from '../projects';
import { pluginDirsForProject } from '../marketplace';
import { SUBTYPE_PROMPTS, PROPOSE_MEMORY_PROMPT } from './internal';

/**
 * N18: measure what the orchestrator injects into an agent's system
 * prompt at spawn, decomposed by source. Mirrors the assembly in
 * `buildSystemPromptFor` (internal.ts) + the spawn-time task preamble,
 * so the numbers reflect the text the app actually controls.
 *
 * Deliberately NOT a runtime usage/cost meter (that surface was cut as
 * noise in v0.24.0). CLI-loaded pieces — marketplace skills passed by
 * `--plugin-dir`, MCP tool schemas behind `--mcp-config` — are surfaced
 * as informational notes, never counted, because their token cost is
 * resolved CLI-side and isn't visible from here.
 */
export function buildContextBreakdown(
  req: ContextBreakdownRequest,
): ContextBreakdown {
  const { projectId, role, subtype, model, task } = req;

  const empty: ContextBreakdown = {
    segments: [],
    totalTokens: 0,
    totalBytes: 0,
    contextWindow: modelContextTokens(model),
    notes: [],
  };

  // `role` crosses the IPC boundary untyped. Anything outside the known
  // role set would feed path traversal into readSkill (skillPathFor
  // joins it into a workspace path) — so gate on the ROLES table, the
  // same posture as the skills writer's ALL_SKILL_KEYS guard.
  if (!ROLES[role]) return empty;

  const project = getProject(projectId);
  const provider = req.provider ?? project?.provider ?? 'claude';

  const seg = (
    label: string,
    text: string,
    hint?: string,
  ): ContextSegment => ({
    label,
    tokens: estimateTokens(text),
    bytes: Buffer.byteLength(text ?? '', 'utf8'),
    ...(hint ? { hint } : {}),
  });

  const segments: ContextSegment[] = [];

  // (1) Base role prompt — the role's hardcoded persona.
  segments.push(
    seg('Base role prompt', ROLES[role].systemPrompt, `Role: ${ROLES[role].label}`),
  );

  // (2) Project skill — .orchestrator/skills/<role>.md, or the built-in default.
  const skill = readSkill(projectId, role);
  if (skill.content.trim()) {
    segments.push(
      seg(
        'Project skill',
        skill.content,
        skill.hasFile
          ? 'Customised in this workspace'
          : 'Built-in default — edit the role skill to change',
      ),
    );
  }

  // (3) Project memory — Claude Code per-project memory (project/reference types only).
  const memory = project?.workspace
    ? loadClaudeCodeMemorySection(project.workspace)
    : '';
  if (memory.trim()) {
    segments.push(
      seg('Project memory', memory, 'From Claude Code memory (MEMORY.md) — trim there'),
    );
  }

  // (4) Subtype flavour — e.g. qa.playwright.
  const flavour = subtype ? (SUBTYPE_PROMPTS[role]?.[subtype] ?? '') : '';
  if (flavour.trim()) {
    segments.push(seg(`Subtype: ${subtype}`, flavour));
  }

  // (5) Memory-propose instruction — universal, appended to every agent.
  segments.push(
    seg('Memory-propose instruction', PROPOSE_MEMORY_PROMPT, 'Universal — same for every agent'),
  );

  // (6) Task — your spawn instruction.
  if (task.trim()) {
    segments.push(seg('Task', task, 'Your spawn instruction'));
  }

  const totalTokens = segments.reduce((n, s) => n + s.tokens, 0);
  const totalBytes = segments.reduce((n, s) => n + s.bytes, 0);

  // CLI-loaded pieces — surfaced, not counted (their real cost is resolved CLI-side).
  const notes: ContextNote[] = [];
  if (provider === 'claude') {
    const pluginDirs = pluginDirsForProject(projectId, role);
    if (pluginDirs.length > 0) {
      const names = pluginDirs
        .map((p) => p.split(/[/\\]/).pop() ?? p)
        .join(', ');
      notes.push({
        label: 'Marketplace skills',
        detail: `${pluginDirs.length} bundle${
          pluginDirs.length === 1 ? '' : 's'
        } (${names}) — loaded by the CLI, not counted above`,
      });
    }
    if (getMcpConfigPath(projectId)) {
      notes.push({
        label: 'MCP tools',
        detail:
          'Config present — tool schemas are loaded by the CLI, so their size is not measurable here',
      });
    }
  } else {
    notes.push({
      label: 'Codex agent',
      detail: 'Marketplace skills and MCP tools do not load for Codex agents',
    });
  }

  return {
    segments,
    totalTokens,
    totalBytes,
    contextWindow: modelContextTokens(model),
    notes,
  };
}
