import type { Agent } from '../../shared/types';

interface Entry {
  agent: Agent;
  controller: AbortController;
}

const entries = new Map<string, Entry>();

export function add(agent: Agent, controller: AbortController): void {
  entries.set(agent.id, { agent, controller });
}

export function get(id: string): Entry | undefined {
  return entries.get(id);
}

export function list(): Agent[] {
  return [...entries.values()].map((e) => e.agent);
}

export function patch(id: string, p: Partial<Agent>): Agent | undefined {
  const e = entries.get(id);
  if (!e) return undefined;
  e.agent = { ...e.agent, ...p };
  return e.agent;
}

export function abort(id: string): boolean {
  const e = entries.get(id);
  if (!e) return false;
  e.controller.abort();
  return true;
}

export function abortAll(): void {
  for (const e of entries.values()) e.controller.abort();
}
