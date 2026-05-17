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

import { estimateCost } from '../../shared/rates';

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
    // is saying. Each chunk may contain multiple lines.
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) console.error('[codex stderr]', line);
    }
  });

  // Prompt goes through stdin — same length-safety argument as the claude
  // runner (avoid Windows' ~32k command-line cap on long task prompts).
  proc.stdin.write(options.prompt, 'utf8');
  proc.stdin.end();

  try {
    yield* parseAndNormalize(proc, () => stderr, options.model ?? 'unknown');
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
  if (o.resume) {
    const args: string[] = ['exec', 'resume', '--json'];
    if (o.model && o.model.length > 0) {
      args.push('-m', o.model);
    }
    if (o.effort) {
      args.push('-c', `model_reasoning_effort="${o.effort}"`);
    }
    args.push('--skip-git-repo-check');
    args.push('--ephemeral');
    args.push(o.resume);
    return args;
  }

  const args: string[] = ['exec', '--json'];

  // ChatGPT-plan users can't specify `-m` explicitly (server returns 400
  // for `gpt-5-codex` etc). Omit the flag entirely when the model is
  // empty/sentinel — codex falls back to its config default which is the
  // right model for the user's account.
  if (o.model && o.model.length > 0) {
    args.push('-m', o.model);
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
  // No session persistence inside ~/.codex — we manage our own session
  // history via the registry. Keeps user's local codex state clean.
  args.push('--ephemeral');

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
        // Diagnostic: log every raw event so we can see what codex
        // actually emitted when the user reports "(empty response)".
        // Visible in the dev console / terminal that started npm start.
        console.error('[codex raw]', JSON.stringify(ev));
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
        for (const out of translated) queue.push(out);
      } catch {
        queue.push({
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
        queue.push(JSON.parse(tail));
      } catch {
        queue.push({
          type: 'result',
          subtype: 'parse_error',
          is_error: true,
          errors: [`failed to parse codex trailing line: ${tail.slice(0, 200)}`],
        });
      }
      buf = '';
    }
    if (code !== 0) {
      queue.push({
        type: 'result',
        subtype: 'process_error',
        is_error: true,
        errors: [
          `codex exited with code ${code}${
            getStderr() ? ` — stderr: ${getStderr().trim().slice(0, 500)}` : ''
          }`,
        ],
      });
    }
    wake();
  });

  proc.on('error', (err) => {
    queue.push({
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
    // Codex doesn't tell us cost; estimate from token rates. estimateCost
    // returns 0 for unknown models — better than reporting a fake number.
    const cost = estimateCost(
      ctx.model,
      cum.input_tokens + cum.cache_read_input_tokens,
      cum.output_tokens,
    );
    return [
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: cost,
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
