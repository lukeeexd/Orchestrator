import { randomUUID } from 'node:crypto';
import type { Agent, AgentRole, LogLine, SpawnAgentRequest } from '../../shared/types';
import { ROLES } from './roles';
import { createWorktree } from './worktree';
import * as registry from './registry';
import { classify, nowTs } from './classifier';
import { readSettings } from '../settings';

export interface RunnerSinks {
  onAgent: (agent: Agent) => void;
  onLog: (agentId: string, line: LogLine) => void;
  onPatch: (agentId: string, patch: Partial<Agent>) => void;
}

let agentCounter: Record<AgentRole, number> = {
  pm: 0,
  researcher: 0,
  coder: 0,
  qa: 0,
  devops: 0,
};

function nextName(role: AgentRole): string {
  agentCounter = { ...agentCounter, [role]: agentCounter[role] + 1 };
  const n = agentCounter[role].toString().padStart(2, '0');
  return `${role === 'researcher' ? 'research' : role}-${n}`;
}

function elapsed(startedAt: number): string {
  const total = Math.floor((Date.now() - startedAt) / 1000);
  const m = Math.floor(total / 60)
    .toString()
    .padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export async function spawnAgent(
  req: SpawnAgentRequest,
  sinks: RunnerSinks,
): Promise<{ agentId: string }> {
  const role = ROLES[req.role];
  const name = nextName(req.role);
  const id = randomUUID();
  const controller = new AbortController();

  const wt = createWorktree(req.workspace, name);

  const agent: Agent = {
    id,
    role: req.role,
    roleLabel: role.label,
    name,
    status: 'running',
    statusLabel: 'Running',
    step: '0/?',
    task: req.task,
    tokens: 0,
    cost: 0,
    elapsed: '00:00',
    model: role.model,
    workspace: req.workspace,
    worktreePath: wt.isWorktree ? wt.workdir : null,
    log: [],
    startedAt: Date.now(),
  };

  registry.add(agent, controller);
  sinks.onAgent(agent);

  const settings = readSettings();
  if (!settings.apiKey) {
    const line: LogLine = {
      ts: nowTs(),
      kind: 'error',
      msg: `ANTHROPIC_API_KEY is empty. Edit settings.json to add it, then spawn again.`,
    };
    sinks.onLog(id, line);
    sinks.onPatch(id, { status: 'error', statusLabel: 'No API key' });
    return { agentId: id };
  }

  // Fire-and-forget the async run; events stream via sinks.
  run(id, req, wt.workdir, settings.apiKey, controller, sinks).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    sinks.onLog(id, { ts: nowTs(), kind: 'error', msg: `runner crashed: ${msg}` });
    sinks.onPatch(id, { status: 'error', statusLabel: 'Crashed' });
  });

  return { agentId: id };
}

async function run(
  agentId: string,
  req: SpawnAgentRequest,
  workdir: string,
  apiKey: string,
  controller: AbortController,
  sinks: RunnerSinks,
): Promise<void> {
  const role = ROLES[req.role];

  // SDK is ESM-only — load it dynamically from our CJS context.
  const sdk = await import('@anthropic-ai/claude-agent-sdk');

  const elapsedTimer = setInterval(() => {
    const e = registry.get(agentId);
    if (!e) {
      clearInterval(elapsedTimer);
      return;
    }
    const next = elapsed(e.agent.startedAt);
    if (next !== e.agent.elapsed) {
      registry.patch(agentId, { elapsed: next });
      sinks.onPatch(agentId, { elapsed: next });
    }
  }, 1000);

  try {
    const q = sdk.query({
      prompt: req.task,
      options: {
        cwd: workdir,
        env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
        abortController: controller,
        permissionMode: 'bypassPermissions',
        agent: 'main',
        agents: {
          main: {
            description: `${role.label} for the Orchestrator app`,
            prompt: role.systemPrompt,
            tools: role.tools,
            model: role.model,
          },
        },
      },
    });

    let turn = 0;
    for await (const event of q) {
      if (controller.signal.aborted) break;
      const ev = event as { type: string; [k: string]: unknown };

      const lines = classify(ev);
      for (const line of lines) {
        const entry = registry.get(agentId);
        if (entry) entry.agent.log.push(line);
        sinks.onLog(agentId, line);
      }

      if (ev.type === 'assistant') {
        turn += 1;
        registry.patch(agentId, { step: `${turn}/?` });
        sinks.onPatch(agentId, { step: `${turn}/?` });
      } else if (ev.type === 'result') {
        const result = ev as unknown as {
          subtype: string;
          total_cost_usd?: number;
          usage?: { input_tokens?: number; output_tokens?: number };
          is_error?: boolean;
          errors?: string[];
        };
        const tokens =
          (result.usage?.input_tokens ?? 0) + (result.usage?.output_tokens ?? 0);
        const cost = result.total_cost_usd ?? 0;
        if (result.subtype === 'success') {
          sinks.onLog(agentId, {
            ts: nowTs(),
            kind: 'handoff',
            msg: 'Task complete',
          });
          registry.patch(agentId, {
            status: 'done',
            statusLabel: 'Done',
            tokens,
            cost,
          });
          sinks.onPatch(agentId, {
            status: 'done',
            statusLabel: 'Done',
            tokens,
            cost,
          });
        } else {
          const errMsg = (result.errors ?? [result.subtype]).join(' · ');
          sinks.onLog(agentId, { ts: nowTs(), kind: 'error', msg: errMsg });
          registry.patch(agentId, {
            status: 'error',
            statusLabel: result.subtype,
            tokens,
            cost,
          });
          sinks.onPatch(agentId, {
            status: 'error',
            statusLabel: result.subtype,
            tokens,
            cost,
          });
        }
      }
    }
  } finally {
    clearInterval(elapsedTimer);
  }
}

export { registry };
