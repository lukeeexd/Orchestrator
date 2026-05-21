import fs from 'node:fs';
import path from 'node:path';
import { assertValidWorkspacePath } from './security/workspace';
import { getProject, setProjectMcpConfig } from './projects';

/**
 * P9 — MCP server scaffolder. Writes a minimal-but-runnable MCP
 * server skeleton into the project's workspace and patches the
 * project's mcpConfig to register the new server in stdio mode.
 *
 * Two languages supported in v1: TypeScript (via
 * @modelcontextprotocol/sdk) and Python (via the official `mcp`
 * package). Each scaffold ships ONE example handler per requested
 * capability so the user can see the shape without having to read
 * the SDK docs cold.
 *
 * Path safety: the destination is validated against the project's
 * workspace via assertValidWorkspacePath + a parent-folder check;
 * a malformed dest can't write outside the workspace tree.
 */

export interface ScaffoldInput {
  projectId: string;
  language: 'typescript' | 'python';
  /** Server id used in mcpConfig and as the directory name. */
  name: string;
  description: string;
  capabilities: {
    tools: boolean;
    resources: boolean;
    prompts: boolean;
  };
}

export interface ScaffoldResult {
  ok: boolean;
  /** Absolute path of the destination directory on success. */
  destination?: string;
  /** Relative-to-workspace path of the files written. */
  filesWritten?: string[];
  error?: string;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/;

export function scaffoldMcpServer(input: ScaffoldInput): ScaffoldResult {
  // Validate the name early — used as both the mcpConfig key AND a
  // directory name, so we need it to be safe for both.
  if (!NAME_PATTERN.test(input.name)) {
    return {
      ok: false,
      error:
        'Name must be lowercase letters / digits / dashes, 2-40 chars (starts with a letter or digit).',
    };
  }
  const project = getProject(input.projectId);
  if (!project) return { ok: false, error: 'project not found' };
  if (!project.workspace) {
    return { ok: false, error: 'project has no workspace set' };
  }
  let workspace: string;
  try {
    workspace = assertValidWorkspacePath(project.workspace);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'workspace invalid',
    };
  }

  // Destination lives under <workspace>/.mcp-servers/<name>. The
  // dotted directory keeps it out of casual `ls` views while staying
  // workspace-local so the user can edit + git-track if they want.
  const dest = path.join(workspace, '.mcp-servers', input.name);
  // Path-safety check: resolve dest and confirm it's still under
  // the workspace root. Belt-and-suspenders against weird name
  // values that get past NAME_PATTERN (shouldn't happen given the
  // regex, but free defense).
  const realWs = fs.realpathSync(workspace);
  const resolvedDest = path.resolve(dest);
  if (!resolvedDest.startsWith(realWs + path.sep)) {
    return {
      ok: false,
      error: 'destination escapes the workspace root',
    };
  }
  if (fs.existsSync(dest)) {
    return {
      ok: false,
      error: `destination already exists: ${dest}`,
    };
  }

  // All checks passed — write files. Each language has its own set;
  // capabilities flag which example handlers to embed.
  const filesWritten: string[] = [];
  try {
    fs.mkdirSync(dest, { recursive: true });
    const files =
      input.language === 'typescript'
        ? buildTypescriptScaffold(input)
        : buildPythonScaffold(input);
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(dest, name);
      fs.writeFileSync(filePath, content);
      filesWritten.push(path.relative(workspace, filePath).replace(/\\/g, '/'));
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'file write failed',
    };
  }

  // Register the new server in the project's mcpConfig in stdio mode.
  // Existing mcpConfig is preserved; we merge the new entry in.
  const command =
    input.language === 'typescript' ? 'node' : 'python';
  const entry =
    input.language === 'typescript'
      ? `node "${path.join(dest, 'index.js')}"`
      : `python "${path.join(dest, 'main.py')}"`;
  // We store the absolute argv form — `claude --mcp-config` reads
  // commands as strings; the user can edit later in the JSON editor
  // if they want a relative form or a different launcher (tsx,
  // poetry, etc).
  try {
    const next = mergeServerIntoConfig(project.mcpConfig, input.name, {
      command,
      args: [
        input.language === 'typescript'
          ? path.join(dest, 'index.js')
          : path.join(dest, 'main.py'),
      ],
    });
    setProjectMcpConfig(input.projectId, next);
  } catch (e) {
    // Files are already written; surface the registration failure but
    // don't roll back the scaffold (the user can hand-add to mcp
    // config if needed). Mention `entry` in the error so they can
    // paste it.
    return {
      ok: false,
      error: `scaffold wrote files but mcpConfig registration failed: ${
        e instanceof Error ? e.message : String(e)
      }. Add manually: command="${command}", args=["${entry}"]`,
      destination: dest,
      filesWritten,
    };
  }

  return {
    ok: true,
    destination: dest,
    filesWritten,
  };
}

function mergeServerIntoConfig(
  existing: string | null | undefined,
  serverName: string,
  entry: { command: string; args: string[] },
): string {
  let parsed: { mcpServers?: Record<string, unknown> } = {};
  if (existing && existing.trim().length > 0) {
    try {
      parsed = JSON.parse(existing);
      if (typeof parsed !== 'object' || parsed === null) parsed = {};
    } catch {
      // Invalid existing JSON — don't lose it; just start fresh and
      // the user can merge by hand if they want.
      parsed = {};
    }
  }
  const mcpServers = (parsed.mcpServers ?? {}) as Record<string, unknown>;
  mcpServers[serverName] = entry;
  parsed.mcpServers = mcpServers;
  return JSON.stringify(parsed, null, 2);
}

// ─────────────────────────── TypeScript scaffold ───────────────────────────

function buildTypescriptScaffold(input: ScaffoldInput): Record<string, string> {
  return {
    'package.json': buildTsPackageJson(input),
    'tsconfig.json': TS_TSCONFIG,
    'index.ts': buildTsIndex(input),
    'README.md': buildReadme(input),
    '.gitignore': 'node_modules/\nindex.js\nindex.js.map\n',
  };
}

function buildTsPackageJson(input: ScaffoldInput): string {
  return (
    JSON.stringify(
      {
        name: input.name,
        version: '0.1.0',
        description: input.description,
        type: 'module',
        main: 'index.js',
        scripts: {
          build: 'tsc',
          start: 'node index.js',
        },
        dependencies: {
          '@modelcontextprotocol/sdk': '^1.0.0',
        },
        devDependencies: {
          typescript: '^5.4.0',
          '@types/node': '^20.0.0',
        },
      },
      null,
      2,
    ) + '\n'
  );
}

const TS_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'ES2022',
      moduleResolution: 'node',
      esModuleInterop: true,
      strict: true,
      skipLibCheck: true,
      outDir: '.',
      rootDir: '.',
    },
    include: ['index.ts'],
  },
  null,
  2,
)}\n`;

function buildTsIndex(input: ScaffoldInput): string {
  const lines: string[] = [
    "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
    "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
    '',
    `const server = new Server(`,
    `  { name: ${JSON.stringify(input.name)}, version: '0.1.0' },`,
    `  { capabilities: {`,
    ...(input.capabilities.tools ? ['    tools: {},'] : []),
    ...(input.capabilities.resources ? ['    resources: {},'] : []),
    ...(input.capabilities.prompts ? ['    prompts: {},'] : []),
    `  } },`,
    `);`,
    '',
  ];

  if (input.capabilities.tools) {
    lines.push(
      "import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';",
      '',
      'server.setRequestHandler(ListToolsRequestSchema, async () => ({',
      '  tools: [',
      '    {',
      "      name: 'hello',",
      "      description: 'Example tool — returns a greeting.',",
      '      inputSchema: {',
      "        type: 'object',",
      "        properties: { name: { type: 'string' } },",
      "        required: ['name'],",
      '      },',
      '    },',
      '  ],',
      '}));',
      '',
      'server.setRequestHandler(CallToolRequestSchema, async (req) => {',
      '  if (req.params.name === \'hello\') {',
      '    const name = (req.params.arguments as { name?: string } | undefined)?.name ?? \'world\';',
      '    return { content: [{ type: \'text\', text: `Hello, ${name}!` }] };',
      '  }',
      "  throw new Error(`Unknown tool: ${req.params.name}`);",
      '});',
      '',
    );
  }

  if (input.capabilities.resources) {
    lines.push(
      "import { ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';",
      '',
      'server.setRequestHandler(ListResourcesRequestSchema, async () => ({',
      '  resources: [',
      `    { uri: '${input.name}://example', name: 'Example resource', mimeType: 'text/plain' },`,
      '  ],',
      '}));',
      '',
      'server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({',
      '  contents: [',
      '    {',
      '      uri: req.params.uri,',
      "      mimeType: 'text/plain',",
      "      text: `Stub content for ${req.params.uri}. Replace with real data.`,",
      '    },',
      '  ],',
      '}));',
      '',
    );
  }

  if (input.capabilities.prompts) {
    lines.push(
      "import { GetPromptRequestSchema, ListPromptsRequestSchema } from '@modelcontextprotocol/sdk/types.js';",
      '',
      'server.setRequestHandler(ListPromptsRequestSchema, async () => ({',
      '  prompts: [',
      "    { name: 'example', description: 'Stub prompt template.' },",
      '  ],',
      '}));',
      '',
      'server.setRequestHandler(GetPromptRequestSchema, async (req) => ({',
      '  messages: [',
      '    {',
      "      role: 'user',",
      "      content: { type: 'text', text: `Stub prompt body for ${req.params.name}.` },",
      '    },',
      '  ],',
      '}));',
      '',
    );
  }

  lines.push(
    'async function main() {',
    '  const transport = new StdioServerTransport();',
    '  await server.connect(transport);',
    '}',
    '',
    'main().catch((err) => {',
    '  console.error(err);',
    '  process.exit(1);',
    '});',
    '',
  );

  return lines.join('\n');
}

// ─────────────────────────────── Python scaffold ───────────────────────────────

function buildPythonScaffold(input: ScaffoldInput): Record<string, string> {
  return {
    'pyproject.toml': buildPyProject(input),
    'main.py': buildPyMain(input),
    'README.md': buildReadme(input),
    '.gitignore': '__pycache__/\n*.pyc\n.venv/\n',
  };
}

function buildPyProject(input: ScaffoldInput): string {
  return (
    [
      '[project]',
      `name = ${JSON.stringify(input.name)}`,
      'version = "0.1.0"',
      `description = ${JSON.stringify(input.description)}`,
      'requires-python = ">=3.10"',
      'dependencies = [',
      '  "mcp>=1.0.0",',
      ']',
    ].join('\n') + '\n'
  );
}

function buildPyMain(input: ScaffoldInput): string {
  const lines: string[] = [
    'import asyncio',
    'from mcp.server import Server',
    'from mcp.server.stdio import stdio_server',
  ];
  if (input.capabilities.tools) {
    lines.push('from mcp.types import Tool, TextContent');
  }
  if (input.capabilities.resources) {
    lines.push('from mcp.types import Resource');
  }
  if (input.capabilities.prompts) {
    lines.push('from mcp.types import Prompt, PromptMessage');
  }
  lines.push(
    '',
    `server = Server(${JSON.stringify(input.name)})`,
    '',
  );

  if (input.capabilities.tools) {
    lines.push(
      '@server.list_tools()',
      'async def list_tools() -> list[Tool]:',
      '    return [',
      '        Tool(',
      '            name="hello",',
      '            description="Example tool — returns a greeting.",',
      '            inputSchema={',
      '                "type": "object",',
      '                "properties": {"name": {"type": "string"}},',
      '                "required": ["name"],',
      '            },',
      '        ),',
      '    ]',
      '',
      '@server.call_tool()',
      'async def call_tool(name: str, arguments: dict) -> list[TextContent]:',
      '    if name == "hello":',
      '        target = arguments.get("name", "world")',
      '        return [TextContent(type="text", text=f"Hello, {target}!")]',
      '    raise ValueError(f"Unknown tool: {name}")',
      '',
    );
  }

  if (input.capabilities.resources) {
    lines.push(
      '@server.list_resources()',
      'async def list_resources() -> list[Resource]:',
      '    return [',
      `        Resource(uri="${input.name}://example", name="Example resource", mimeType="text/plain"),`,
      '    ]',
      '',
      '@server.read_resource()',
      'async def read_resource(uri: str) -> str:',
      '    return f"Stub content for {uri}. Replace with real data."',
      '',
    );
  }

  if (input.capabilities.prompts) {
    lines.push(
      '@server.list_prompts()',
      'async def list_prompts() -> list[Prompt]:',
      '    return [Prompt(name="example", description="Stub prompt template.")]',
      '',
      '@server.get_prompt()',
      'async def get_prompt(name: str, arguments: dict | None = None) -> list[PromptMessage]:',
      '    return [',
      '        PromptMessage(',
      '            role="user",',
      '            content=TextContent(type="text", text=f"Stub prompt body for {name}."),',
      '        ),',
      '    ]',
      '',
    );
  }

  lines.push(
    'async def main():',
    '    async with stdio_server() as (read_stream, write_stream):',
    '        await server.run(',
    '            read_stream,',
    '            write_stream,',
    '            server.create_initialization_options(),',
    '        )',
    '',
    'if __name__ == "__main__":',
    '    asyncio.run(main())',
    '',
  );
  return lines.join('\n');
}

function buildReadme(input: ScaffoldInput): string {
  const caps: string[] = [];
  if (input.capabilities.tools) caps.push('tools');
  if (input.capabilities.resources) caps.push('resources');
  if (input.capabilities.prompts) caps.push('prompts');
  const capsList = caps.length > 0 ? caps.join(', ') : '(none yet)';

  return [
    `# ${input.name}`,
    '',
    input.description || '_No description._',
    '',
    `Scaffolded by Orchestrator. Implements ${capsList}.`,
    '',
    '## Build and run',
    '',
    input.language === 'typescript'
      ? '```\nnpm install\nnpm run build\n```'
      : '```\npip install -e .\n```',
    '',
    'Orchestrator already wired this server into the project\'s `mcpConfig` ' +
      'in stdio mode — agents will pick it up on their next spawn (claude ' +
      'projects only; codex ignores per-project MCP).',
    '',
    '## Customising',
    '',
    'Edit the example handlers in ' +
      (input.language === 'typescript' ? '`index.ts`' : '`main.py`') +
      ' to do real work. Capability handlers can be added or removed; ' +
      'restart agent spawns after changes (the CLI re-reads `mcpConfig` ' +
      'on each spawn so a fresh agent picks up your edits).',
    '',
  ].join('\n');
}
