import { useCallback, useEffect, useState } from 'react';
import type { DirectorMessage, DirectorMode } from '../../shared/types';

interface UseDirectorResult {
  messages: DirectorMessage[];
  send: (body: string, mode: DirectorMode) => Promise<void>;
  busy: boolean;
}

export function useDirector(): UseDirectorResult {
  const [messages, setMessages] = useState<DirectorMessage[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    window.api.listDirectorMessages().then((initial) => {
      if (mounted) setMessages(initial);
    });

    const offMessage = window.api.onDirectorMessage(({ message }) => {
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

    const offPatch = window.api.onDirectorPatch(({ id, patch }) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      );
      if (patch.live === false) setBusy(false);
    });

    return () => {
      mounted = false;
      offMessage();
      offPatch();
    };
  }, []);

  const send = useCallback(async (body: string, mode: DirectorMode) => {
    if (!body.trim()) return;
    setBusy(true);
    await window.api.sendToDirector(body, mode);
  }, []);

  return { messages, send, busy };
}
