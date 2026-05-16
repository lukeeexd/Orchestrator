/**
 * Process-scoped cache of the claude-CLI probe result. Set once during
 * app.whenReady(), then read by the IPC handler whenever the renderer
 * asks. Lives in its own file so the IPC layer doesn't pull in
 * cli/spawn.ts (and its child_process imports) just to read a flag.
 */

export interface ClaudeCliStatus {
  available: boolean;
  version: string | null;
}

let cached: ClaudeCliStatus = { available: false, version: null };

export function setClaudeCliStatus(next: ClaudeCliStatus): void {
  cached = next;
}

export function getClaudeCliStatus(): ClaudeCliStatus {
  return cached;
}
