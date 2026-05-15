import { useCallback, useEffect, useState } from 'react';
import type { Project } from '../../shared/types';

interface UseProjectsResult {
  projects: Project[];
  activeId: string | null;
  setActive: (id: string) => Promise<void>;
  create: (name: string, workspace: string) => Promise<Project>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  reload: () => Promise<void>;
}

export function useProjects(): UseProjectsResult {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [list, active] = await Promise.all([
      window.api.listProjects(),
      window.api.getActiveProjectId(),
    ]);
    setProjects(list);
    setActiveId(active);
  }, []);

  useEffect(() => {
    void reload();
    const off = window.api.onActiveProjectChanged(({ projectId }) => {
      setActiveId(projectId);
    });
    return off;
  }, [reload]);

  const setActive = useCallback(
    async (id: string) => {
      await window.api.setActiveProject(id);
      setActiveId(id);
    },
    [],
  );

  const create = useCallback(
    async (name: string, workspace: string) => {
      const p = await window.api.createProject(name, workspace);
      await reload();
      return p;
    },
    [reload],
  );

  const rename = useCallback(
    async (id: string, name: string) => {
      await window.api.renameProject(id, name);
      await reload();
    },
    [reload],
  );

  const remove = useCallback(
    async (id: string) => {
      await window.api.deleteProject(id);
      await reload();
    },
    [reload],
  );

  return { projects, activeId, setActive, create, rename, remove, reload };
}
