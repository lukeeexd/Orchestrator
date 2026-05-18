import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  DocumentContentBlock,
  ImageContentBlock,
} from '../attachments';

/**
 * The shape of options we pass to a single claude-CLI invocation. Mirrors
 * the bits of the SDK options object we used before — kept as a flat
 * struct so each call site is self-documenting.
 */
export interface ClaudeQueryOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  prompt: string;
  /**
   * Optional image content blocks to send alongside the text prompt. When
   * non-empty (or `documents` is non-empty), this switches the CLI to
   * `--input-format stream-json` and sends a JSONL user message with
   * text + image + document content blocks. The text-only path stays
   * unchanged for the common case (no extra wire overhead).
   */
  images?: ImageContentBlock[];
  /** Optional PDF content blocks. Same trigger semantics as `images`. */
  documents?: DocumentContentBlock[];
  /**
   * Optional path to an MCP server config JSON file (the shape `claude
   * --mcp-config` expects, typically `{"mcpServers": {...}}`). Skipped
   * when absent or when the file doesn't exist on disk.
   */
  mcpConfigPath?: string;
  /** Per-agent definitions, passed as `--agents <json>`. Same shape as the SDK's options.agents. */
  agents: Record<
    string,
    {
      description: string;
      prompt: string;
      tools: string[];
      model?: string;
      effort?: string;
    }
  >;
  /** Which agent inside `agents` to run. Passed as `--agent <name>`. */
  agent: string;
  /** Session id to resume. Passed as `--resume <id>`. */
  resume?: string;
  /** When true, resuming creates a new session id instead of reusing. */
  forkSession?: boolean;
  /** Beta headers (e.g. 'context-1m-2025-08-07'). */
  betas?: readonly string[];
  /** AbortController used to terminate the subprocess. */
  abortController: AbortController;
}

interface SpawnedProc {
  proc: ChildProcessWithoutNullStreams;
  /** Stderr is captured separately and surfaced as a single string in `crashed` events. */
  stderr: string;
}

/**
 * Spawn the `claude` CLI in non-interactive stream-json mode and yield
 * each event the CLI writes to stdout. Each line of stdout is one
 * JSON-encoded event from claude's event stream — identical in shape to
 * what the SDK's async iterator used to yield.
 *
 * The async generator terminates when:
 *   - the subprocess exits (clean stdout EOF), OR
 *   - the abortController fires (we kill the process), OR
 *   - stdout produces an unparseable line (we surface a synthetic 'result'
 *     error event so the runner can treat it like any other crash).
 */
export async function* runClaudeQuery(
  options: ClaudeQueryOptions,
): AsyncGenerator<unknown, void, unknown> {
  const args = buildArgs(options);

  // stdio: pipe all three so we can write the prompt to stdin, parse
  // stream-json from stdout, and capture stderr for diagnostics. Using
  // shell: false means the args array is passed verbatim — no shell
  // metacharacters can do anything funny.
  const proc = spawn('claude', args, {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    shell: false,
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;

  // Forward abort → SIGTERM. proc.kill() returns false on Windows if the
  // process is already dead; that's fine, we just want to be sure.
  const onAbort = () => {
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  };
  options.abortController.signal.addEventListener('abort', onAbort);

  const spawned: SpawnedProc = { proc, stderr: '' };
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk: string) => {
    spawned.stderr += chunk;
  });

  // Send the prompt as stdin and close it. Using stdin (rather than the
  // positional [prompt] argument) sidesteps Windows' ~32k command-line
  // length limit — agents inline attachments and long task descriptions
  // can blow past it.
  //
  // When there are image OR document attachments, switch to stream-json
  // input and wrap the prompt in a user-message envelope with content
  // blocks. The CLI's stream-json input format mirrors the
  // messages.create API shape, so vision blocks ({type:'image'}) and
  // document blocks ({type:'document'}) ride along. When there are
  // none, stay on plain-text stdin to keep the common-case wire shape
  // unchanged.
  const hasImages = !!options.images && options.images.length > 0;
  const hasDocuments = !!options.documents && options.documents.length > 0;
  if (hasImages || hasDocuments) {
    const userMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: options.prompt },
          ...(options.images ?? []).map((img) => ({
            type: 'image',
            source: {
              type: 'base64',
              media_type: img.mediaType,
              data: img.base64,
            },
          })),
          ...(options.documents ?? []).map((doc) => ({
            type: 'document',
            source: {
              type: 'base64',
              media_type: doc.mediaType,
              data: doc.base64,
            },
          })),
        ],
      },
    };
    proc.stdin.write(JSON.stringify(userMessage) + '\n', 'utf8');
  } else {
    proc.stdin.write(options.prompt, 'utf8');
  }
  proc.stdin.end();

  try {
    yield* parseStdout(spawned);
  } finally {
    options.abortController.signal.removeEventListener('abort', onAbort);
    if (!proc.killed && proc.exitCode === null) {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }
  }
}

function buildArgs(o: ClaudeQueryOptions): string[] {
  const args: string[] = [
    '--print',
    '--output-format',
    'stream-json',
    // stream-json requires verbose mode; it's the flag that enables the
    // per-event line emission.
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    '--agents',
    JSON.stringify(o.agents),
    '--agent',
    o.agent,
  ];

  // When sending images or documents, switch the input format to
  // stream-json so we can wrap the prompt + content blocks in a single
  // JSONL user message. The text-only path uses the CLI's default text
  // stdin.
  if (
    (o.images && o.images.length > 0) ||
    (o.documents && o.documents.length > 0)
  ) {
    args.push('--input-format', 'stream-json');
  }

  if (o.resume) {
    args.push('--resume', o.resume);
  }
  if (o.forkSession) {
    args.push('--fork-session');
  }
  if (o.betas && o.betas.length > 0) {
    args.push('--betas', ...o.betas);
  }
  if (o.mcpConfigPath) {
    args.push('--mcp-config', o.mcpConfigPath);
  }

  return args;
}

async function* parseStdout(
  spawned: SpawnedProc,
): AsyncGenerator<unknown, void, unknown> {
  const proc = spawned.proc;
  proc.stdout.setEncoding('utf8');

  let buf = '';
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  // A simple async queue: producer is the 'data'/'close' listeners, consumer
  // is the for-await loop in the runner. We yield one event per next().
  const queue: unknown[] = [];
  let waiter: ((done: boolean) => void) | null = null;
  const wake = (done: boolean) => {
    const w = waiter;
    waiter = null;
    w?.(done);
  };

  proc.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
      if (!line) continue;
      try {
        queue.push(JSON.parse(line));
      } catch {
        // Synthesise a crash-style result event the runner already knows
        // how to handle. Better than throwing — the rest of the stream
        // is still possibly intact, and the user sees a clear error.
        queue.push({
          type: 'result',
          subtype: 'parse_error',
          is_error: true,
          errors: [`failed to parse line: ${line.slice(0, 200)}`],
        });
      }
    }
    wake(false);
  });

  proc.on('close', (code, signal) => {
    exitInfo = { code, signal };
    // Drain any trailing line without a newline (rare but the CLI is
    // not strictly newline-terminated).
    const tail = buf.trim();
    if (tail) {
      try {
        queue.push(JSON.parse(tail));
      } catch {
        queue.push({
          type: 'result',
          subtype: 'parse_error',
          is_error: true,
          errors: [`failed to parse trailing line: ${tail.slice(0, 200)}`],
        });
      }
      buf = '';
    }
    // If the CLI exited non-zero AND we never saw a terminal result
    // event, synthesise one so the runner can mark the agent as crashed
    // instead of silently leaving it 'running'.
    if (code !== 0) {
      queue.push({
        type: 'result',
        subtype: 'process_error',
        is_error: true,
        errors: [
          `claude exited with code ${code}${signal ? ` (signal ${signal})` : ''}${
            spawned.stderr ? ` — stderr: ${spawned.stderr.trim().slice(0, 500)}` : ''
          }`,
        ],
      });
    }
    wake(true);
  });

  proc.on('error', (err) => {
    queue.push({
      type: 'result',
      subtype: 'spawn_error',
      is_error: true,
      errors: [
        `failed to spawn claude: ${err.message}. Is 'claude' on your PATH?`,
      ],
    });
    exitInfo = { code: -1, signal: null };
    wake(true);
  });

  while (true) {
    if (queue.length > 0) {
      yield queue.shift();
      continue;
    }
    if (exitInfo) return;
    await new Promise<void>((resolve) => {
      waiter = (done) => {
        resolve();
        if (done) {
          // queue may have drained-then-refilled in the time we were paused;
          // loop will handle either case.
        }
      };
    });
  }
}

/**
 * Probe `claude --version` once at startup. Returns the version string on
 * success or null if the CLI isn't on PATH or fails to launch. Used to
 * surface a helpful error before any spawn attempt.
 */
/**
 * Probe `<bin> --version` once. Returns the version string on success
 * or null if the binary isn't on PATH or fails to launch. Used to
 * surface a helpful error before any spawn attempt. Same shape for
 * both claude and codex probes — caller picks the bin name.
 */
export async function probeCli(
  bin: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(bin, ['--version'], {
      env,
      shell: false,
      windowsHide: true,
    });
    let out = '';
    proc.stdout?.on('data', (c) => (out += c.toString('utf8')));
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else resolve(null);
    });
  });
}

/** Backwards-compatible wrapper kept for the existing call site. */
export async function probeClaudeCli(
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  return probeCli('claude', env);
}
