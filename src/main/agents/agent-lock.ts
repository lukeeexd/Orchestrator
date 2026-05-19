/**
 * Per-agent serialization for runner entry points.
 *
 * Why: spawn / redirect / fork / abort all mutate the same agent's
 * status + controller + completion entry. Without serialization, two
 * IPC calls landing in the same tick can race past the status check
 * and both flip an already-running agent to running, leaving the
 * earlier controller orphaned. Single per-agent mutex closes that
 * window for the cost of one Map lookup per entry call.
 *
 * The lock should only wrap the **critical section** (status check
 * + flip + controller swap + kicking off the async work). Holding
 * it across the full agent run would block abort from ever landing.
 *
 * Plus: a generation-tagged completion tracker. The previous design
 * used a plain `Map<id, Promise>` with a `setTimeout(() => delete)`
 * 60s tail for GC. When a redirect overwrote the entry, the earlier
 * timer still fired and dropped the NEW entry mid-flight, so
 * `awaitCompletion(id)` would resolve early for an agent still
 * running. Tagging each entry with a generation number lets the
 * timer skip the delete when the entry it's looking at isn't the
 * one it was scheduled for.
 */

interface CompletionEntry {
  promise: Promise<void>;
  gen: number;
}

const chains = new Map<string, Promise<unknown>>();
const completions = new Map<string, CompletionEntry>();
let genCounter = 1;

/**
 * Run `fn` exclusively for `id`. Concurrent callers queue behind
 * each other. `fn` is invoked regardless of whether the prior
 * holder resolved or rejected — one failed operation must not
 * block subsequent ones.
 */
export function withAgentLock<T>(
  id: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const prev = chains.get(id) ?? Promise.resolve();
  const next = prev.then(
    () => fn(),
    () => fn(),
  );
  chains.set(id, next);
  const drop = (): void => {
    if (chains.get(id) === next) chains.delete(id);
  };
  next.then(drop, drop);
  return next;
}

/**
 * Register an in-flight async run for the given agent id.
 * `awaitCompletion(id)` will resolve once `work` settles (either
 * way). Replaces any prior entry — useful when a redirect or fork
 * starts a fresh run on the same id.
 */
export function trackCompletion(id: string, work: Promise<void>): void {
  const gen = genCounter++;
  // Wrap the awaiter promise so it never rejects — consumers
  // (acceptPlan's sequential loop) only care about "done", not
  // success vs failure.
  const noop = (): void => undefined;
  const awaiter = work.then(noop, noop);
  completions.set(id, { promise: awaiter, gen });
  awaiter.then(() => {
    setTimeout(() => {
      const cur = completions.get(id);
      if (cur && cur.gen === gen) completions.delete(id);
    }, 60_000);
  });
}

/**
 * Resolves when the agent's currently-tracked run settles. Returns
 * an immediately-resolved promise if the agent has no in-flight
 * run (already done, never spawned, or expired from the cleanup
 * tail).
 */
export function awaitCompletion(id: string): Promise<void> {
  return completions.get(id)?.promise ?? Promise.resolve();
}
