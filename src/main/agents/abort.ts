import type { Agent } from '../../shared/types';
import * as registry from './registry';
import type { RunnerSinks } from './internal';
import { withAgentLock } from './agent-lock';

/**
 * Abort a running agent. Acquires the per-agent lock so we serialize
 * with any in-flight redirect/fork critical section — without this,
 * an abort racing a redirect's controller-swap can land on the
 * pre-swap controller and the post-swap run continues unaffected.
 */
export async function abortAgent(
  id: string,
  sinks: RunnerSinks,
): Promise<{ ok: boolean }> {
  return withAgentLock(id, () => {
    const ok = registry.abort(id);
    if (ok) {
      const patch: Partial<Agent> = {
        status: 'aborted',
        statusLabel: 'Aborted',
      };
      registry.patch(id, patch);
      sinks.onPatch(id, patch);
    }
    return { ok };
  });
}
