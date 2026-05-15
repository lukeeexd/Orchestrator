import type { Agent } from '../../shared/types';
import * as persistence from '../persistence';

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

export function listForProject(projectId: string): Agent[] {
  return [...entries.values()]
    .map((e) => e.agent)
    .filter((a) => a.projectId === projectId);
}

export function patch(id: string, p: Partial<Agent>): Agent | undefined {
  const e = entries.get(id);
  if (!e) return undefined;
  e.agent = { ...e.agent, ...p };
  persistence.patchAgent(id, p);
  return e.agent;
}

export function abort(id: string): boolean {
  const e = entries.get(id);
  if (!e) return false;
  e.controller.abort();
  return true;
}

/** Swap an agent's controller — used when redirecting a done/error agent. */
export function setController(id: string, controller: AbortController): boolean {
  const e = entries.get(id);
  if (!e) return false;
  e.controller = controller;
  return true;
}

export function abortAll(): void {
  for (const e of entries.values()) e.controller.abort();
}

export function remove(id: string): boolean {
  const e = entries.get(id);
  if (!e) return false;
  // Make sure nothing's still running before we drop the entry.
  e.controller.abort();
  entries.delete(id);
  return true;
}

/**
 * Reload agents from disk at startup. Restored agents have a no-op
 * controller because we can't resume their SDK sessions — any that
 * were running at shutdown were already flipped to 'error: Interrupted'
 * by persistence.markRunningAgentsAsInterrupted().
 */
export function hydrate(): void {
  const stored = persistence.loadAgents();
  entries.clear();
  for (const agent of stored) {
    entries.set(agent.id, { agent, controller: new AbortController() });
  }
}
