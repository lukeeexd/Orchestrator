import {
  attributePathToSkill,
  bumpSkillFire,
  resolveLoadout,
  type LoadoutReport,
} from '../marketplace';

/**
 * Skill-fire telemetry helpers shared by the query module. Pulled out
 * of runner.ts so the heart of consumeQuery doesn't have to inline
 * three private functions just to bump usage counters.
 *
 * Strictly best-effort: every call site handles missing / null loadouts
 * gracefully so a marketplace I/O hiccup never crashes an agent run.
 */

export function safeResolveLoadout(
  projectId: string,
  role: string,
): LoadoutReport | null {
  try {
    return resolveLoadout(projectId, role);
  } catch {
    // Don't let telemetry errors crash the run — telemetry is a
    // nice-to-have. The runner already emits its own diagnostic note
    // for the actual plugin-dir load right before consumeQuery.
    return null;
  }
}

/**
 * Detect skill activations in an assistant event and bump per-skill
 * fire counters. Used by `consumeQuery` to power the Agent skills
 * usage-telemetry chips.
 *
 * Two signals it watches for:
 *   1. A `Skill` (or `skill`) tool_use whose input names a known
 *      skill id (`skill`, `name`, or `skill_name` fields).
 *   2. A path-bearing tool_use (Read/Glob/Bash/Edit/Write/etc.) whose
 *      input contains a string falling inside one of the loaded
 *      skill directories.
 *
 * Per-turn dedupe: if the same skill is referenced by multiple
 * tool_use blocks in a single assistant message (e.g. a Read of
 * SKILL.md followed by Reads of its reference files), it only bumps
 * once. Otherwise a single activation can show up as 3-4 fires and
 * skew the "actually used" signal.
 */
export function detectAndBumpSkillFires(
  ev: unknown,
  loadout: LoadoutReport,
  projectId: string,
  role: string,
): void {
  if (!ev || typeof ev !== 'object') return;
  const message = (ev as { message?: { content?: unknown[] } }).message;
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return;

  const firedThisTurn = new Set<string>();
  for (const raw of blocks) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as { type?: string; name?: string; input?: unknown };
    if (block.type !== 'tool_use' || typeof block.name !== 'string') continue;
    const matched = findSkillFromToolUse(block.name, block.input, loadout);
    if (!matched) continue;
    const key = `${matched.sourceId}\x00${matched.bundleId}\x00${matched.skillId}`;
    if (firedThisTurn.has(key)) continue;
    firedThisTurn.add(key);
    bumpSkillFire(
      projectId,
      role,
      matched.sourceId,
      matched.bundleId,
      matched.skillId,
    );
  }
}

function findSkillFromToolUse(
  toolName: string,
  input: unknown,
  loadout: LoadoutReport,
): { sourceId: string; bundleId: string; skillId: string } | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;

  // Special-case the Skill tool. Field names vary across CLI versions;
  // accept any of the common ones.
  if (toolName === 'Skill' || toolName === 'skill') {
    const candidate =
      (typeof obj.skill === 'string' && obj.skill) ||
      (typeof obj.name === 'string' && obj.name) ||
      (typeof obj.skill_name === 'string' && obj.skill_name) ||
      null;
    if (candidate) {
      for (const entry of loadout.entries) {
        const sk = entry.skills.find((s) => s.id === candidate);
        if (sk) {
          return {
            sourceId: entry.sourceId,
            bundleId: entry.bundleId,
            skillId: sk.id,
          };
        }
      }
    }
  }

  // General: scan string inputs for a path that resolves under a
  // skill directory in the loadout.
  for (const value of Object.values(obj)) {
    if (typeof value !== 'string') continue;
    const matched = attributePathToSkill(value, loadout);
    if (matched) return matched;
  }
  return null;
}
