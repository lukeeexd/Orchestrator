import { useCallback, useEffect, useState } from 'react';
import type { Agent } from '../../shared/types';

interface UseAgentsResult {
  agents: Agent[];
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  expanded: Record<string, boolean>;
  toggle: (id: string) => void;
}

export function useAgents(): UseAgentsResult {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let mounted = true;
    window.api.listAgents().then((initial) => {
      if (mounted) setAgents(initial);
    });

    const offAgent = window.api.onAgent(({ agent }) => {
      setAgents((prev) => {
        const idx = prev.findIndex((a) => a.id === agent.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = agent;
          return next;
        }
        return [...prev, agent];
      });
      setExpanded((prev) => ({ ...prev, [agent.id]: true }));
    });

    const offLog = window.api.onLog(({ agentId, line }) => {
      setAgents((prev) =>
        prev.map((a) =>
          a.id === agentId ? { ...a, log: [...a.log, line] } : a,
        ),
      );
    });

    const offPatch = window.api.onPatch(({ agentId, patch }) => {
      setAgents((prev) =>
        prev.map((a) => (a.id === agentId ? { ...a, ...patch } : a)),
      );
    });

    const offRemove = window.api.onAgentRemove(({ agentId }) => {
      setAgents((prev) => prev.filter((a) => a.id !== agentId));
      setSelectedId((prev) => (prev === agentId ? null : prev));
      setExpanded((prev) => {
        if (!(agentId in prev)) return prev;
        const next = { ...prev };
        delete next[agentId];
        return next;
      });
    });

    return () => {
      mounted = false;
      offAgent();
      offLog();
      offPatch();
      offRemove();
    };
  }, []);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  return { agents, selectedId, setSelectedId, expanded, toggle };
}
