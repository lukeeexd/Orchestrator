/**
 * MCP-config command extraction.
 *
 * `claude --mcp-config <path>` reads JSON in the shape
 *   { "mcpServers": { "<name>": { "command": "<binary>", "args": [...] }, ... } }
 * and spawns each command on every agent run for the project. A
 * compromised or hijacked renderer that can write the MCP config
 * effectively gets a stored RCE channel.
 *
 * This module extracts the list of commands so the IPC layer can:
 *   - surface them to the renderer for a "this will execute X on
 *     every spawn" confirmation,
 *   - log them as a Director system message so there's a visible
 *     audit trail of when MCP servers were added.
 *
 * Invalid JSON or wrong shape throws — the caller decides whether
 * to reject the commit or just report empty commands (the preview
 * call does the latter, the commit call does the former).
 */

export function extractMcpCommands(configJson: string): string[] {
  const parsed: unknown = JSON.parse(configJson);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('mcp config must be a JSON object');
  }
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (servers == null) return [];
  if (typeof servers !== 'object') {
    throw new Error('mcpServers must be an object');
  }
  const out: string[] = [];
  for (const [name, server] of Object.entries(
    servers as Record<string, unknown>,
  )) {
    if (!server || typeof server !== 'object') continue;
    const command = (server as { command?: unknown }).command;
    if (typeof command !== 'string' || command.length === 0) continue;
    out.push(`${name}: ${command}`);
  }
  return out;
}
