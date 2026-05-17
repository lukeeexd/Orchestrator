import type { Provider } from '../../shared/types';

/**
 * Process-scoped cache of CLI probe results — one per provider. Set
 * once during app.whenReady(), then read by the IPC handler whenever
 * the renderer asks. Lives in its own file so the IPC layer doesn't
 * pull in cli/spawn.ts (and its child_process imports) just to read
 * a flag.
 */

export interface CliStatus {
  available: boolean;
  version: string | null;
}

export type CliStatusMap = Record<Provider, CliStatus>;

let cached: CliStatusMap = {
  claude: { available: false, version: null },
  codex: { available: false, version: null },
};

export function setCliStatus(provider: Provider, next: CliStatus): void {
  cached = { ...cached, [provider]: next };
}

export function getCliStatus(provider: Provider): CliStatus {
  return cached[provider];
}

export function getAllCliStatus(): CliStatusMap {
  return cached;
}

// Backwards-compat: the renderer used to call getClaudeCliStatus().
// Keep the old shape working while the IPC layer is being widened.
export function setClaudeCliStatus(next: CliStatus): void {
  setCliStatus('claude', next);
}

export function getClaudeCliStatus(): CliStatus {
  return getCliStatus('claude');
}
