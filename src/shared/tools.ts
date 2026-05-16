/**
 * Canonical tool ids the UI exposes in the role × tool allow-list grid.
 * These are the standard Claude Code tool names — passed through to the
 * SDK's `agents.<name>.tools` field verbatim. Custom MCP tools aren't
 * included yet; that's a follow-up feature (see PLAN.md).
 *
 * If a project's stored role_tools include a name that isn't in this
 * list (e.g. an MCP tool from a future build), it's preserved at
 * runtime but hidden from the grid — round-trip safe.
 */
export interface ToolDef {
  id: string;
  /** One-line description shown in the grid's tooltip. */
  description: string;
  /** Whether this tool can mutate disk/state. Used for the destructive-tools warning chip. */
  destructive: boolean;
}

export const KNOWN_TOOLS: readonly ToolDef[] = [
  { id: 'Read', description: 'Read a file from disk.', destructive: false },
  { id: 'Glob', description: 'Find files matching a glob pattern.', destructive: false },
  { id: 'Grep', description: 'Search file contents with ripgrep.', destructive: false },
  { id: 'Write', description: 'Create or overwrite a file.', destructive: true },
  { id: 'Edit', description: 'Modify part of an existing file.', destructive: true },
  { id: 'Bash', description: 'Run shell commands. The big one — implies arbitrary file/system access.', destructive: true },
  { id: 'WebFetch', description: 'Fetch a URL and return its content.', destructive: false },
  { id: 'WebSearch', description: 'Search the web for information.', destructive: false },
];

export function isKnownTool(id: string): boolean {
  return KNOWN_TOOLS.some((t) => t.id === id);
}
