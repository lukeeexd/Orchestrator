/**
 * Agent runner — public barrel.
 *
 * The runner used to be a single 1,196-line file; S7 split it into
 * focused modules under `src/main/agents/` so each entry point
 * (spawn / fork / redirect / abort) lives next to its own private
 * executor, the shared CLI orchestration (buildQuery / consumeQuery)
 * has its own home, and helpers don't crowd the entry-point code.
 *
 * This file is the contract — the only path the rest of the app
 * imports from. Internals (internal.ts, query.ts, skillFires.ts) are
 * NOT re-exported here; they're implementation details.
 */

import * as registry from './registry';

export { spawnAgent } from './spawn';
export { forkAgent } from './fork';
export { redirectAgent } from './redirect';
export { abortAgent } from './abort';
export { runEndOfPlanGate } from './gate';
export { awaitCompletion, type RunnerSinks } from './internal';

// `registry` is consumed directly by the IPC layer (e.g.
// agents.ts's spawnAgent handler reads back the freshly-spawned
// agent's name via registry.get). Re-exporting the namespace keeps
// the pre-split import path working.
export { registry };
