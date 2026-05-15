import { useCallback, useEffect, useState } from 'react';
import type { DirectorMessage, DirectorMode } from '../../shared/types';

interface UseDirectorResult {
  messages: DirectorMessage[];
  send: (
    body: string,
    mode: DirectorMode,
    attachments?: string[],
  ) => Promise<void>;
  busy: boolean;
}

export function useDirector(projectId: string | null): UseDirectorResult {
  const [messages, setMessages] = useState<DirectorMessage[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!projectId) {
      setMessages([]);
      setBusy(false);
      return;
    }
    let mounted = true;
    window.api.listDirectorMessages(projectId).then((initial) => {
      if (mounted) setMessages(initial);
    });
    return () => {
      mounted = false;
    };
  }, [projectId]);

  useEffect(() => {
    const offMessage = window.api.onDirectorMessage(({ projectId: pid, message }) => {
      if (pid !== projectId) return;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === message.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = message;
          return next;
        }
        return [...prev, message];
      });
      if (message.who === 'director' && message.live) setBusy(true);
    });

    const offPatch = window.api.onDirectorPatch(({ projectId: pid, id, patch }) => {
      if (pid !== projectId) return;
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      );
      if (patch.live === false) setBusy(false);
    });

    return () => {
      offMessage();
      offPatch();
    };
  }, [projectId]);

  const send = useCallback(
    async (body: string, mode: DirectorMode, attachments?: string[]) => {
      if (!projectId) return;
      if (!body.trim() && !(attachments && attachments.length > 0)) return;
      setBusy(true);
      await window.api.sendToDirector(projectId, body, mode, attachments);
    },
    [projectId],
  );

  return { messages, send, busy };
}
