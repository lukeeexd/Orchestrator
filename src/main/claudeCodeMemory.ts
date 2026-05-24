import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * F16 (feature-proposals.md companion): bridge Claude Code's per-project
 * auto-memory into Orchestrator's agent prompts.
 *
 * Claude Code stores per-project memories at
 *   ~/.claude/projects/<encoded-workspace-path>/memory/
 * (overridable via the CLAUDE_CONFIG_DIR env var). The encoding:
 * Windows `D:\foo\bar` becomes `D--foo-bar` — the drive's `:\`
 * collapses to `--` and remaining path separators become `-`.
 *
 * Each project dir contains MEMORY.md (an index of `- [Title](file.md)
 * — description` lines) plus one .md file per memory with YAML
 * frontmatter declaring `type: user | feedback | project | reference`.
 *
 * We only include `project` and `reference` types in agent prompts:
 *   - `project`   — codebase facts (constraints, deadlines, motivations)
 *   - `reference` — pointers to external systems (Linear, Grafana, etc.)
 * Skipped types:
 *   - `user`      — about the user themselves (irrelevant for agent work)
 *   - `feedback`  — directives to the assistant ("Don't push main
 *                   without merge") that would confuse agents if applied
 *                   to them
 *
 * No-op when the directory doesn't exist (user hasn't used Claude Code
 * on this project) or when the index is empty.
 */

/** Per-spec frontmatter `metadata.type` values. */
type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

const INCLUDED_TYPES: ReadonlySet<MemoryType> = new Set(['project', 'reference']);

/**
 * Translate a workspace path into the Claude Code project-dir name.
 * Pure function — exported so it can be unit-tested without filesystem.
 */
export function encodeWorkspacePath(workspace: string): string {
  // Normalize to forward-slash first so Windows/POSIX paths get the same
  // treatment, then handle the Windows drive prefix explicitly. The
  // observed pattern in `~/.claude/projects/` shows `D:\foo\bar` →
  // `D--foo-bar` (drive letter + `--` + dashed remainder).
  const normalized = workspace.replace(/\\/g, '/');
  // Match a Windows drive prefix `D:/...` and collapse the `:` away.
  const driveMatch = /^([A-Za-z]):\/?(.*)$/.exec(normalized);
  if (driveMatch) {
    const [, drive, rest] = driveMatch;
    return `${drive}--${rest.replace(/\//g, '-')}`;
  }
  // POSIX path — strip leading slash, dash the rest.
  return normalized.replace(/^\//, '').replace(/\//g, '-');
}

/** Root of Claude Code's per-user data dir, respecting CLAUDE_CONFIG_DIR. */
function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Returns the project's memory dir, or null if it doesn't exist. */
function projectMemoryDir(workspace: string): string | null {
  const encoded = encodeWorkspacePath(workspace);
  const dir = path.join(claudeHome(), 'projects', encoded, 'memory');
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Parse MEMORY.md and return the referenced filenames in encounter
 * order. The index format is one entry per line:
 *
 *   - [Title](file.md) — description
 *
 * We accept any markdown-link target ending in `.md` and silently
 * ignore everything else. Section headers and free-form prose between
 * entries are tolerated.
 */
export function parseMemoryIndex(indexBody: string): string[] {
  const refs: string[] = [];
  const re = /\]\(([^)]+\.md)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(indexBody)) !== null) {
    const target = match[1].trim();
    // Skip absolute URLs and absolute paths — the dir-scoped reader
    // only resolves relative file names.
    if (/^[a-z]+:\/\//i.test(target) || target.startsWith('/')) continue;
    if (target === 'MEMORY.md') continue;
    refs.push(target);
  }
  return refs;
}

/**
 * Parse one memory file: returns the type from the YAML frontmatter +
 * the body (without the frontmatter block). Tolerates files without
 * frontmatter (returns type=null + the whole body).
 */
export function parseMemoryFile(raw: string): {
  type: MemoryType | null;
  body: string;
} {
  const fmMatch = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(raw);
  if (!fmMatch) {
    return { type: null, body: raw.trim() };
  }
  const frontmatter = fmMatch[1];
  const body = raw.slice(fmMatch[0].length).trim();
  // Look for either `type: project` (root-level) or `metadata: { type: project }`
  // (nested under `metadata:`). The Claude Code template uses the
  // nested form; we accept both for forwards-compat.
  const nestedMatch = /metadata:\s*\n(?:[ \t]+[^\n]*\n)*?[ \t]+type:\s*([a-z]+)/i.exec(
    frontmatter,
  );
  const flatMatch = /^type:\s*([a-z]+)\s*$/im.exec(frontmatter);
  const raw_type = (nestedMatch?.[1] || flatMatch?.[1] || '').toLowerCase();
  const type =
    raw_type === 'user' ||
    raw_type === 'feedback' ||
    raw_type === 'project' ||
    raw_type === 'reference'
      ? (raw_type as MemoryType)
      : null;
  return { type, body };
}

/**
 * Build the markdown section to append to an agent's system prompt.
 * Returns the empty string when no usable memory is available — the
 * caller can safely concatenate the result without checking length.
 */
export function loadClaudeCodeMemorySection(workspace: string): string {
  if (!workspace) return '';
  const dir = projectMemoryDir(workspace);
  if (!dir) return '';
  const indexPath = path.join(dir, 'MEMORY.md');
  let indexRaw: string;
  try {
    indexRaw = fs.readFileSync(indexPath, 'utf8');
  } catch {
    return '';
  }
  const refs = parseMemoryIndex(indexRaw);
  if (refs.length === 0) return '';

  const blocks: string[] = [];
  for (const ref of refs) {
    // Path-safety: refuse anything that escapes the memory dir via
    // `..` segments. The index is user-controlled so a misbehaving
    // edit shouldn't be able to read arbitrary host files.
    const resolved = path.resolve(dir, ref);
    if (!resolved.startsWith(dir + path.sep) && resolved !== dir) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(resolved, 'utf8');
    } catch {
      continue;
    }
    const { type, body } = parseMemoryFile(raw);
    if (!type || !INCLUDED_TYPES.has(type)) continue;
    if (body.length === 0) continue;
    blocks.push(body);
  }

  if (blocks.length === 0) return '';
  return (
    '\n\n## Claude Code project memory\n\n' +
    "Context the assistant has accumulated about this project across " +
    "conversations. These are facts about the project itself, not " +
    "instructions for you. Treat them as background you can rely on " +
    "(don't quote them back).\n\n" +
    blocks.join('\n\n---\n\n')
  );
}
