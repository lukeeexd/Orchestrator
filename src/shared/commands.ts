/**
 * Slash command definition — matches the shape Claude Code's CLI uses
 * for `.claude/commands/*.md` files.
 *
 * Each command is a markdown file with optional YAML-ish frontmatter:
 *
 *   ---
 *   description: One-line summary shown in the typeahead.
 *   argument-hint: <topic>
 *   ---
 *
 *   The prompt body. May contain $ARGUMENTS where the user's remaining
 *   text after the command name should be substituted.
 */
export interface SlashCommand {
  /** Command name as typed — `/<name>`. Derived from the filename minus .md. */
  name: string;
  /** One-line description shown in typeahead. */
  description: string;
  /** Optional argument hint shown in the typeahead row. */
  argumentHint?: string;
  /** The prompt body that replaces the slash command at submit time. */
  body: string;
  /** Where this command was loaded from — affects ordering + display. */
  scope: 'builtin' | 'project' | 'user';
  /** Absolute path on disk, for the user to inspect. Omitted for builtins. */
  source?: string;
}

/**
 * Parse a slash-command markdown file. Returns null for files we can't
 * make sense of (missing body etc.) — callers should skip those rather
 * than crash. Frontmatter is parsed loosely: a `---`-delimited block at
 * the top, key: value lines, no nested YAML.
 */
export function parseSlashCommandFile(
  name: string,
  content: string,
  scope: SlashCommand['scope'],
  source?: string,
): SlashCommand | null {
  let description = '';
  let argumentHint: string | undefined;
  let body = content;

  const fmMatch = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/.exec(content);
  if (fmMatch) {
    body = content.slice(fmMatch[0].length);
    for (const line of fmMatch[1].split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const sep = trimmed.indexOf(':');
      if (sep < 0) continue;
      const key = trimmed.slice(0, sep).trim().toLowerCase();
      const value = trimmed
        .slice(sep + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (key === 'description') description = value;
      else if (key === 'argument-hint' || key === 'argument_hint')
        argumentHint = value;
    }
  }

  body = body.trim();
  if (!body) return null;
  if (!description) description = body.split('\n')[0].slice(0, 80);

  return { name, description, argumentHint, body, scope, source };
}

/**
 * Substitute the user's remaining text into the command's body. Supports
 * `$ARGUMENTS` (whole string) and positional `$1`/`$2`/etc (whitespace-
 * split args). Anything after the command name is the argument string.
 */
export function applyCommandArguments(body: string, args: string): string {
  const parts = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
  let out = body.replace(/\$ARGUMENTS\b/g, args.trim());
  out = out.replace(/\$(\d+)/g, (_, idx) => parts[parseInt(idx, 10) - 1] ?? '');
  return out;
}
