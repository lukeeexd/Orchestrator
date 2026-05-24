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

// F8: auto-stamp endedAt whenever an agent transitions to a terminal
// status. Doing this in the registry means every code path through
// `patch` (spawn / fork / redirect / query result / abort / shutdown)
// gets the timestamp for free — callers don't have to remember.
//
// We deliberately do NOT clear endedAt when the agent flips back to
// running via redirect. The timeline view treats `status === running`
// as live ("draw the bar to now") and only consults endedAt for
// terminal rows. The next terminal transition overwrites whatever
// stale value was there.
const TERMINAL_STATUSES = new Set<Agent['status']>([
  'done',
  'error',
  'paused',
]);

export function patch(id: string, p: Partial<Agent>): Agent | undefined {
  const e = entries.get(id);
  if (!e) return undefined;
  // We mutate `p` in place when stamping endedAt so the same object
  // reference the caller passed to sinks.onPatch picks up the new
  // field — the renderer event stays a single hop. Documented:
  // patches are caller-fresh objects in every existing call site,
  // so mutation is safe.
  if (
    p.status !== undefined &&
    TERMINAL_STATUSES.has(p.status) &&
    p.endedAt === undefined
  ) {
    p.endedAt = Date.now();
  }
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
