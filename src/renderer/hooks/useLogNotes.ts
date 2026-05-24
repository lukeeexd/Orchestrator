import { useCallback, useEffect, useState } from 'react';

/**
 * F12: per-agent log-line notes. Fetches every note for the agent
 * on select, indexes by `lineKey` for O(1) lookup during the log-line
 * render pass. `setNote` does an optimistic in-memory update before
 * the IPC round-trip so the renderer feels instant; an empty body
 * deletes the row.
 *
 * The hook re-fetches whenever `agentId` changes; passing `null`
 * clears the map (used when the Drawer is closed).
 */
export function useLogNotes(agentId: string | null): {
  notes: Map<string, string>;
  setNote: (lineKey: string, body: string) => Promise<void>;
} {
  const [notes, setNotes] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!agentId) {
      setNotes(new Map());
      return;
    }
    let cancelled = false;
    window.api
      .listLogNotes(agentId)
      .then((list) => {
        if (cancelled) return;
        const m = new Map<string, string>();
        for (const n of list) m.set(n.lineKey, n.body);
        setNotes(m);
      })
      .catch(() => {
        // Best-effort. A failed list leaves the map empty; the user
        // can still set new notes from scratch.
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const setNote = useCallback(
    async (lineKey: string, body: string) => {
      if (!agentId) return;
      const trimmed = body.trim();
      // Optimistic local update so the textarea closes immediately.
      setNotes((prev) => {
        const next = new Map(prev);
        if (trimmed) next.set(lineKey, trimmed);
        else next.delete(lineKey);
        return next;
      });
      try {
        const r = await window.api.setLogNote(agentId, lineKey, trimmed);
        if (!r.ok) {
          // Roll the optimistic update back by re-fetching.
          const list = await window.api.listLogNotes(agentId);
          const m = new Map<string, string>();
          for (const n of list) m.set(n.lineKey, n.body);
          setNotes(m);
        }
      } catch {
        // Network / IPC fail — same rollback path.
        try {
          const list = await window.api.listLogNotes(agentId);
          const m = new Map<string, string>();
          for (const n of list) m.set(n.lineKey, n.body);
          setNotes(m);
        } catch {
          /* best-effort */
        }
      }
    },
    [agentId],
  );

  return { notes, setNote };
}
