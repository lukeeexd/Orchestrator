/**
 * Curated MCP server presets. Each preset knows how to render its own
 * configuration form (`fields`), how to build a final MCP entry from
 * the form values (`build`), and how to read the values back out of a
 * stored entry for editing (`parse`).
 *
 * The renderer's MCP tab uses these to offer one-click install of
 * common servers without making the user hand-craft JSON. Power users
 * can still ignore the preset cards and edit the JSON directly — both
 * paths feed the same project.mcpConfig string.
 */

export interface McpField {
  key: string;
  label: string;
  /** Free-text help shown under the input. */
  help?: string;
  placeholder?: string;
  type?: 'text' | 'password' | 'paths';
  required?: boolean;
}

/**
 * Shape of one server inside `mcpServers`. Matches what
 * `claude --mcp-config` reads.
 */
export interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpPreset {
  /** Stable key under `mcpServers`. */
  id: string;
  label: string;
  description: string;
  /** Optional docs URL — rendered as a "learn more" link in the modal. */
  docs?: string;
  fields: McpField[];
  build: (values: Record<string, string>) => McpServerEntry;
  /**
   * Reverse of `build` — pulls form values out of an existing entry so
   * the Edit modal pre-fills correctly. Implementations should return
   * an empty string for any field they can't recover (e.g. an env var
   * the user already had set in their shell rather than in the
   * config).
   */
  parse: (entry: McpServerEntry) => Record<string, string>;
}

/**
 * Split a multi-line / comma-separated paths input into an args array.
 * Tolerates trailing whitespace and blank lines so users can paste
 * paths in whatever shape feels natural.
 */
function splitPaths(raw: string): string[] {
  return raw
    .split(/[\r\n,]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'sequential-thinking',
    label: 'Sequential Thinking',
    description:
      "Anthropic's meta-reasoning helper. Lets agents step through complex tasks more deliberately. No configuration needed.",
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    fields: [],
    build: () => ({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    }),
    parse: () => ({}),
  },
  {
    id: 'memory',
    label: 'Memory',
    description:
      'Lightweight knowledge-graph memory the agent can persist across turns. Useful when you want facts to outlive a single session.',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    fields: [],
    build: () => ({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
    }),
    parse: () => ({}),
  },
  {
    id: 'github',
    label: 'GitHub',
    description:
      'Read issues / PRs / files, create PRs, comment on diffs. Useful for coder + qa + researcher roles.',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    fields: [
      {
        key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        label: 'Personal access token',
        type: 'password',
        required: true,
        help: 'Create at github.com/settings/tokens. Classic or fine-grained both work; grant `repo` for private repo access.',
      },
    ],
    build: (v) => ({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: v.GITHUB_PERSONAL_ACCESS_TOKEN ?? '',
      },
    }),
    parse: (e) => ({
      GITHUB_PERSONAL_ACCESS_TOKEN:
        e.env?.GITHUB_PERSONAL_ACCESS_TOKEN ?? '',
    }),
  },
  {
    id: 'brave-search',
    label: 'Brave Search',
    description:
      'Free-form web search via the Brave Search API. A real upgrade over the built-in WebFetch tool for researcher agents.',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
    fields: [
      {
        key: 'BRAVE_API_KEY',
        label: 'Brave API key',
        type: 'password',
        required: true,
        help: 'Sign up at api.search.brave.com — the free tier covers light personal use.',
      },
    ],
    build: (v) => ({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search'],
      env: { BRAVE_API_KEY: v.BRAVE_API_KEY ?? '' },
    }),
    parse: (e) => ({ BRAVE_API_KEY: e.env?.BRAVE_API_KEY ?? '' }),
  },
  {
    id: 'filesystem',
    label: 'Filesystem (extra paths)',
    description:
      'Give agents read/write access to directories beyond the project workspace — handy for reading sibling repos or shared notes.',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    fields: [
      {
        key: 'paths',
        label: 'Allowed paths',
        type: 'paths',
        required: true,
        placeholder: 'C:\\path\\to\\repo\nC:\\notes',
        help: 'One absolute path per line (or comma-separated). The agent can read and write inside these directories.',
      },
    ],
    build: (v) => ({
      command: 'npx',
      args: [
        '-y',
        '@modelcontextprotocol/server-filesystem',
        ...splitPaths(v.paths ?? ''),
      ],
    }),
    parse: (e) => {
      // First two args are the npx fixed-prefix; everything after is paths.
      const args = e.args ?? [];
      const paths = args.slice(2);
      return { paths: paths.join('\n') };
    },
  },
];

/**
 * Parse a project.mcpConfig string into an `mcpServers` object. Returns
 * an empty object for invalid / empty inputs so callers can treat
 * "no servers installed" and "config corrupted" the same — the JSON
 * textarea below is the right place to debug corruption.
 */
export function parseMcpServers(
  raw: string | undefined,
): Record<string, McpServerEntry> {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (!servers || typeof servers !== 'object') return {};
    return servers as Record<string, McpServerEntry>;
  } catch {
    return {};
  }
}

/**
 * Stringify an `mcpServers` map back to a project.mcpConfig string in
 * the canonical shape `claude --mcp-config` expects. Uses 2-space
 * indentation so the textarea reads cleanly.
 */
export function stringifyMcpServers(
  servers: Record<string, McpServerEntry>,
): string {
  if (Object.keys(servers).length === 0) return '';
  return JSON.stringify({ mcpServers: servers }, null, 2);
}
