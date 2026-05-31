/**
 * R-A8: strip `orchestrator-*` fenced blocks from free-form, agent-authored
 * text before it lands anywhere an orchestrator directive could be (mis)read.
 *
 * Shared by two boundaries:
 *   - the Director input boundary (`director/runner.ts` notifyAgentDone) — an
 *     agent summary that reaches the Director must not be able to forge a
 *     plan/redirect/prd directive on the next turn; and
 *   - the N6 run-context digest injected into later agents' prompts
 *     (`runDigest.ts`) — defence-in-depth so a buggy/compromised agent's
 *     summary can't smuggle a fence into a peer agent's prompt.
 *
 * Pure (regex only) so the pure `runDigest` module can import it without
 * pulling in Electron.
 */
const ORCHESTRATOR_FENCE_RE = /```orchestrator-[a-z]+\s*\n[\s\S]*?\n```/gi;

export function stripOrchestratorFences(s: string): string {
  if (!s) return s;
  return s.replace(ORCHESTRATOR_FENCE_RE, '[orchestrator-fence redacted]');
}
