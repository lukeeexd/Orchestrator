import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Spawn the user's `codex exec` CLI and yield events shaped like claude's
 * stream-json so consumeQuery doesn't need to know which provider it's
 * reading from.
 *
 * Codex emits a much simpler JSONL stream than claude:
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"...","type":"agent_message","text":"..."}}
 *   {"type":"item.completed","item":{"id":"...","type":"shell_command", ...}}  // for tool calls
 *   {"type":"turn.completed","usage":{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}}
 *
 * We translate those into:
 *   {type: 'system', subtype: 'init', session_id: <thread_id>}
 *   {type: 'assistant', message: { content: [{type:'text', text:...}], usage: {...} }}
 *   {type: 'result', subtype: 'success', total_cost_usd: <computed>, usage: {...}}
 *
 * Cost is computed from rates.ts since Codex doesn't emit total_cost_usd.
 * Tool calls (shell_command items) are mapped to assistant tool_use blocks
 * so the classifier picks them up the same way.
 */


export interface CodexQueryOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  prompt: string;
  /** Codex model id (e.g. 'gpt-5-codex'). Falls back to user's codex config default if undefined. */
  model?: string;
  /** Resume an existing Codex thread (top-level `codex resume`) by id. */
  resume?: string;
  /** Fork an existing Codex thread into a new id (`codex fork --last` style). */
  forkSession?: boolean;
  /** Sandbox policy. Default 'workspace-write' — matches our default permissionMode behaviour. */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Reasoning effort for models that support it. Maps to -c model_reasoning_effort. */
  effort?: string;
  abortController: AbortController;
}

export async function* runCodexQuery(
  options: CodexQueryOptions,
): AsyncGenerator<unknown, void, unknown> {
  const args = buildArgs(options);

  const proc = spawn('codex', args, {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    shell: false,
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;

  const onAbort = () => {
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  };
  options.abortController.signal.addEventListener('abort', onAbort);

  let stderr = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    // Live stderr so we don't have to wait for exit to see what codex
    // is saying. Each chunk may contain multiple lines. Filter the
    // "Reading prompt from stdin..." chatter — it fires on every
    // invocation and isn't actionable.
    for (const line of chunk.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === 'Reading prompt from stdin...') continue;
      console.error('[codex stderr]', line);
    }
  });

  // Prompt goes through stdin — same length-safety argument as the claude
  // runner (avoid Windows' ~32k command-line cap on long task prompts).
  proc.stdin.write(options.prompt, 'utf8');
  proc.stdin.end();

  try {
    // For storage/display purposes, treat empty model (ChatGPT-plan
    // users where we don't pass -m) as 'gpt-5-codex' — that's the
    // de-facto default codex picks server-side, and it gives the
    // Spend screen a known rate-table entry to estimate against.
    const displayModel =
      options.model && options.model.length > 0 ? options.model : 'gpt-5-codex';
    yield* parseAndNormalize(proc, () => stderr, displayModel);
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

function buildArgs(o: CodexQueryOptions): string[] {
  // `codex exec resume` and `codex exec` accept overlapping but not
  // identical flag sets. Resume rejects `--sandbox` and `-C` (both are
  // baked into the original session). Everything else we use
  // (--json, --skip-git-repo-check, --ephemeral, -m, -c) is still
  // accepted on resume — earlier I'd over-stripped to avoid the
  // sandbox error and lost --skip-git-repo-check, which then made
  // resume die with "Not inside a trusted directory."
  // Whether to put -m on the wire. ChatGPT-plan accounts reject explicit
  // model selection with a 400; `gpt-5-codex` is our display id but
  // never gets passed. Anything else (a hand-set custom model, future
  // API-plan-only ids) does pass through.
  const shouldPassModel =
    !!o.model && o.model.length > 0 && o.model !== 'gpt-5-codex';

  if (o.resume) {
    const args: string[] = ['exec', 'resume', '--json'];
    if (shouldPassModel) {
      args.push('-m', o.model as string);
    }
    if (o.effort) {
      args.push('-c', `model_reasoning_effort="${o.effort}"`);
    }
    args.push('--skip-git-repo-check');
    args.push(o.resume);
    return args;
  }

  const args: string[] = ['exec', '--json'];

  if (shouldPassModel) {
    args.push('-m', o.model as string);
  }
  if (o.effort) {
    args.push('-c', `model_reasoning_effort="${o.effort}"`);
  }
  // Sandbox policy — coarser than claude's tool allowlist but it's what
  // Codex offers. Default to workspace-write so the agent can actually
  // edit files in the project; matches our bypassPermissions intent.
  args.push('--sandbox', o.sandbox ?? 'workspace-write');
  // Don't refuse to run when the workspace isn't a git repo. Orchestrator
  // workspaces can be anything.
  args.push('--skip-git-repo-check');

  // NOTE: we deliberately do NOT pass --ephemeral. Without persisted
  // session files, `codex exec resume` later returns
  // "no rollout found for thread id X" — and we need resume for both
  // the Director's between-turn continuation AND for agent
  // redirect/fork. The cost is that codex's session dir
  // (~/.codex/sessions/) accumulates rollouts; a future feature could
  // tag-and-clean them based on agent lifecycle if it becomes a
  // disk-space issue.

  // Working directory.
  args.push('-C', o.cwd);

  return args;
}

async function* parseAndNormalize(
  proc: ChildProcessWithoutNullStreams,
  getStderr: () => string,
  model: string,
): AsyncGenerator<unknown, void, unknown> {
  proc.stdout.setEncoding('utf8');

  let buf = '';
  let exited = false;
  let exitCode: number | null = null;

  const queue: unknown[] = [];
  let waiter: (() => void) | null = null;
  // M7: tracks whether any terminal `result` event has been pushed.
  // If codex returns 0 but never emits turn.completed, we synthesize
  // one on close so the runner reaches a final status instead of
  // hanging on 'running' forever.
  let terminalEmitted = false;
  const pushQueue = (ev: unknown): void => {
    if (
      ev &&
      typeof ev === 'object' &&
      (ev as { type?: unknown }).type === 'result'
    ) {
      terminalEmitted = true;
    }
    queue.push(ev);
  };
  const wake = () => {
    const w = waiter;
    waiter = null;
    w?.();
  };

  // Track session id from thread.started → emit as soon as we see it so
  // the runner can persist it for resume/fork later.
  let sessionId: string | null = null;
  // Aggregate usage across all turns so the final 'result' event reports
  // cumulative numbers consistent with how claude's result event behaves.
  let cumulativeInput = 0;
  let cumulativeCachedInput = 0;
  let cumulativeOutput = 0;
  let cumulativeReasoning = 0;
  // Capture the last item.completed message text — emitted as a synthetic
  // assistant event so the Director's plan-block parsing keeps working
  // (it scans assistant message text for the fenced JSON block).
  proc.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const raw = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
      if (!raw) continue;

      try {
        const ev = JSON.parse(raw) as Record<string, unknown>;
        // M9: log every raw codex event only when DEBUG_CODEX_RAW
        // is set. Previously this fired unconditionally and the
        // assistant messages + any pasted user content accumulated
        // in production user log files. Off by default; flip the
        // env var when investigating "(empty response)" reports.
        if (process.env.DEBUG_CODEX_RAW) {
          console.error('[codex raw]', JSON.stringify(ev));
        }
        const translated = translate(ev, {
          sessionId: () => sessionId,
          setSessionId: (id) => {
            sessionId = id;
          },
          addUsage: (u) => {
            cumulativeInput += u.input_tokens ?? 0;
            cumulativeCachedInput += u.cached_input_tokens ?? 0;
            cumulativeOutput += u.output_tokens ?? 0;
            cumulativeReasoning += u.reasoning_output_tokens ?? 0;
          },
          getCumulativeUsage: () => ({
            input_tokens: cumulativeInput,
            cache_read_input_tokens: cumulativeCachedInput,
            cache_creation_input_tokens: 0, // Codex doesn't expose this
            output_tokens: cumulativeOutput + cumulativeReasoning,
          }),
          model,
        });
        for (const out of translated) pushQueue(out);
      } catch {
        pushQueue({
          type: 'result',
          subtype: 'parse_error',
          is_error: true,
          errors: [`failed to parse codex line: ${raw.slice(0, 200)}`],
        });
      }
    }
    wake();
  });

  proc.on('close', (code) => {
    exited = true;
    exitCode = code;
    const tail = buf.trim();
    if (tail) {
      try {
        const parsed = JSON.parse(tail);
        // Run trailing JSON through `translate` too so a final
        // turn.completed in the buffer still produces the
        // result/usage event (and flips terminalEmitted) instead of
        // going through as a raw codex object the runner doesn't
        // understand.
        const translated = translate(parsed as Record<string, unknown>, {
          sessionId: () => sessionId,
          setSessionId: (id) => {
            sessionId = id;
          },
          addUsage: (u) => {
            cumulativeInput += u.input_tokens ?? 0;
            cumulativeCachedInput += u.cached_input_tokens ?? 0;
            cumulativeOutput += u.output_tokens ?? 0;
            cumulativeReasoning += u.reasoning_output_tokens ?? 0;
          },
          getCumulativeUsage: () => ({
            input_tokens: cumulativeInput,
            cache_read_input_tokens: cumulativeCachedInput,
            cache_creation_input_tokens: 0,
            output_tokens: cumulativeOutput + cumulativeReasoning,
          }),
          model,
        });
        for (const out of translated) pushQueue(out);
      } catch {
        pushQueue({
          type: 'result',
          subtype: 'parse_error',
          is_error: true,
          errors: [`failed to parse codex trailing line: ${tail.slice(0, 200)}`],
        });
      }
      buf = '';
    }
    if (code !== 0) {
      pushQueue({
        type: 'result',
        subtype: 'process_error',
        is_error: true,
        errors: [
          `codex exited with code ${code}${
            getStderr() ? ` — stderr: ${getStderr().trim().slice(0, 500)}` : ''
          }`,
        ],
      });
    } else if (!terminalEmitted) {
      // M7: codex exited cleanly but never emitted turn.completed.
      // Without this synth event, the runner's for-await loop just
      // exits and the agent's status stays on 'running' forever.
      pushQueue({
        type: 'result',
        subtype: 'no_terminal_event',
        is_error: true,
        errors: [
          'codex exited cleanly but never emitted turn.completed',
        ],
        session_id: sessionId ?? undefined,
      });
    }
    wake();
  });

  proc.on('error', (err) => {
    pushQueue({
      type: 'result',
      subtype: 'spawn_error',
      is_error: true,
      errors: [
        `failed to spawn codex: ${err.message}. Is 'codex' on your PATH?`,
      ],
    });
    exited = true;
    wake();
  });

  while (true) {
    if (queue.length > 0) {
      yield queue.shift();
      continue;
    }
    if (exited) {
      // Suppress unused-variable warning while still keeping exitCode in
      // scope for future inspection.
      void exitCode;
      return;
    }
    await new Promise<void>((resolve) => {
      waiter = resolve;
    });
  }
}

interface TranslationContext {
  sessionId: () => string | null;
  setSessionId: (id: string) => void;
  addUsage: (u: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  }) => void;
  getCumulativeUsage: () => {
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    output_tokens: number;
  };
  model: string;
}

/**
 * Translate one Codex event into zero or more claude-shaped events. Returns
 * an array because some Codex events expand into multiple claude events
 * (a `turn.completed` with usage emits both a synthesised final usage on
 * the assistant block AND the terminal result).
 */
function translate(
  ev: Record<string, unknown>,
  ctx: TranslationContext,
): unknown[] {
  const type = ev.type;

  if (type === 'thread.started') {
    const threadId = ev.thread_id;
    if (typeof threadId === 'string' && threadId.length > 0) {
      ctx.setSessionId(threadId);
    }
    return [
      {
        type: 'system',
        subtype: 'init',
        session_id: typeof threadId === 'string' ? threadId : undefined,
        model: ctx.model,
      },
    ];
  }

  if (type === 'item.completed') {
    const item = ev.item as
      | {
          id?: string;
          type?: string;
          text?: string;
          command?: string;
          name?: string;
          status?: string;
          output?: string;
        }
      | undefined;
    if (!item) return [];
    if (item.type === 'agent_message') {
      // Text response from the model → synth an assistant event with a
      // single text content block.
      return [
        {
          type: 'assistant',
          message: {
            id: item.id,
            model: ctx.model,
            content: [{ type: 'text', text: item.text ?? '' }],
            // Per-message usage isn't emitted by Codex; cumulative goes
            // out on the final result. We send a zero block so the
            // runner's per-turn cost-accounting branch doesn't crash on
            // missing fields.
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          session_id: ctx.sessionId() ?? undefined,
        },
      ];
    }
    // Anything else (shell commands, file edits, tool results) — surface
    // as an assistant turn carrying a tool_use block so the classifier
    // picks it up under the 'tool' log kind.
    const fnName =
      item.name ??
      item.type ??
      'codex_tool';
    return [
      {
        type: 'assistant',
        message: {
          id: item.id,
          model: ctx.model,
          content: [
            {
              type: 'tool_use',
              id: item.id ?? `codex-${Date.now()}`,
              name: fnName,
              input:
                item.command !== undefined
                  ? { command: item.command }
                  : item.status !== undefined
                  ? { status: item.status }
                  : {},
            },
          ],
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        session_id: ctx.sessionId() ?? undefined,
      },
    ];
  }

  if (type === 'turn.completed') {
    const usage = (ev.usage ?? {}) as {
      input_tokens?: number;
      cached_input_tokens?: number;
      output_tokens?: number;
      reasoning_output_tokens?: number;
    };
    ctx.addUsage(usage);
    const cum = ctx.getCumulativeUsage();
    return [
      {
        type: 'result',
        subtype: 'success',
        usage: cum,
        session_id: ctx.sessionId() ?? undefined,
      },
    ];
  }

  // Pass-through everything else (turn.started, future event types we
  // haven't mapped yet, etc.). consumeQuery ignores types it doesn't
  // recognise, so unknown events are harmless.
  return [ev];
}
