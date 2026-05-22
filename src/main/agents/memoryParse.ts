import type { AgentRole } from '../../shared/types';
import { recordProposal } from '../memoryProposals';
import { broadcast } from '../ipc/_shared';
import { IpcChannels } from '../../shared/ipc';

/**
 * Scan an assistant event's text blocks for fenced `orchestrator-memory`
 * blocks. Each one becomes a pending memory proposal in the DB and is
 * broadcast so the Drawer's Memory tab can update live.
 *
 * Mirrors the existing pattern used for `orchestrator-plan` /
 * `orchestrator-prd` / `orchestrator-redirect` (parsed out of the
 * Director's text) — agents emit the memory block in their own
 * assistant turns.
 *
 * Empty proposals (block with no body) are dropped by `recordProposal`
 * so they don't pollute the queue when an agent emits a malformed
 * block by mistake.
 */
const MEMORY_RE = /```orchestrator-memory\s*\n([\s\S]*?)\n```/gi;

export function extractMemoryProposalsFromEvent(
  event: unknown,
  ctx: {
    projectId: string;
    role: AgentRole;
    agentId: string;
    agentName: string;
  },
): void {
  if (event == null || typeof event !== 'object' || !('type' in event)) return;
  const ev = event as { type: string; message?: { content?: unknown[] } };
  if (ev.type !== 'assistant') return;
  const blocks = ev.message?.content ?? [];
  for (const raw of blocks) {
    if (raw == null || typeof raw !== 'object' || !('type' in raw)) continue;
    const block = raw as { type: string; text?: string };
    if (block.type !== 'text' || typeof block.text !== 'string') continue;

    // Global regex — reset lastIndex per text block so iteration starts
    // from the beginning each time we enter this function.
    MEMORY_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MEMORY_RE.exec(block.text)) !== null) {
      const body = match[1] ?? '';
      const proposal = recordProposal({
        projectId: ctx.projectId,
        role: ctx.role,
        body,
        sourceAgentId: ctx.agentId,
        sourceAgentName: ctx.agentName,
      });
      if (proposal) {
        broadcast(IpcChannels.MemoryEventProposal, proposal);
      }
    }
  }
}
