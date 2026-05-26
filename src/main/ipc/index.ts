/**
 * IPC handler registration. Each domain owns its handlers under
 * src/main/ipc/<domain>.ts and exposes a `register<Domain>Handlers(ctx)`
 * function. This barrel just sequences them.
 *
 * `agentSinks` (the broadcast plumbing the runner uses for spawn/log/
 * patch events) is created inside the agents module and threaded into
 * the director module — DirectorAcceptPlan spawns agents directly and
 * needs to hand them the same sinks. Everything else takes only `ctx`.
 *
 * Adding a new domain:
 *   1. Create `src/main/ipc/<name>.ts` exporting `register<Name>Handlers`
 *   2. Add it to the channels list in `src/shared/ipc.ts`
 *   3. Wire its register call here
 */

import { broadcast, type IpcContext } from './_shared';
import { captureHandlers } from './dispatch';
import { registerAppHandlers } from './app';
import { registerSettingsHandlers } from './settings';
import { registerMiscHandlers } from './misc';
import { registerTemplatesHandlers } from './templates';
import { registerProjectsHandlers } from './projects';
import { registerAgentsHandlers } from './agents';
import { registerAttachmentsHandlers } from './attachments';
import { registerDirectorHandlers } from './director';
import { registerMarketplaceHandlers } from './marketplace';

/**
 * @param opts.capture — A3 (headless): record every registered handler
 *   into the dispatch map so headless mode can invoke them over stdio.
 *   GUI boots skip this (byte-identical to before — no capture shim).
 */
export function registerIpcHandlers(opts?: { capture?: boolean }): void {
  const ctx: IpcContext = { broadcast };

  // Modules without state-change broadcasts skip the ctx argument
  // entirely. The asymmetry is intentional — the unused arg would just
  // be lint noise (the `_unused` convention isn't honoured here since
  // the eslint config doesn't set argsIgnorePattern).
  const doRegister = (): void => {
    registerAppHandlers();
    registerSettingsHandlers(ctx);
    registerMiscHandlers();
    registerTemplatesHandlers(ctx);
    registerProjectsHandlers(ctx);
    // agents.ts returns the sinks so director.ts can reuse them when its
    // DirectorAcceptPlan handler triggers spawns directly.
    const agentSinks = registerAgentsHandlers(ctx);
    registerAttachmentsHandlers();
    registerDirectorHandlers(ctx, agentSinks);
    registerMarketplaceHandlers(ctx);
  };

  if (opts?.capture) {
    captureHandlers(doRegister);
  } else {
    doRegister();
  }
}
