import { useCallback, useEffect, useState } from 'react';
import type {
  AgentRole,
  EffortLevel,
  Project,
  Provider,
} from '../../shared/types';

interface UseProjectsResult {
  projects: Project[];
  activeId: string | null;
  setActive: (id: string) => Promise<void>;
  create: (
    name: string,
    workspace: string,
    provider?: Provider,
  ) => Promise<Project>;
  rename: (id: string, name: string) => Promise<void>;
  setWorkspace: (id: string, workspace: string) => Promise<void>;
  setDirectorModel: (id: string, model: string) => Promise<void>;
  setDirectorEffort: (id: string, effort: EffortLevel) => Promise<void>;
  setDirectorProvider: (id: string, provider: Provider | null) => Promise<void>;
  setAutoBranch: (id: string, on: boolean) => Promise<void>;
  setMcpConfig: (
    id: string,
    config: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
  setRoleTools: (
    id: string,
    roleTools: Partial<Record<AgentRole, string[]>> | null,
  ) => Promise<void>;
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
    async (name: string, workspace: string, provider?: Provider) => {
      const p = await window.api.createProject(name, workspace, provider);
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

  const setWorkspace = useCallback(
    async (id: string, workspace: string) => {
      await window.api.setProjectWorkspace(id, workspace);
      await reload();
    },
    [reload],
  );

  const setDirectorModel = useCallback(
    async (id: string, model: string) => {
      await window.api.setProjectDirectorModel(id, model);
      await reload();
    },
    [reload],
  );

  const setDirectorEffort = useCallback(
    async (id: string, effort: EffortLevel) => {
      await window.api.setProjectDirectorEffort(id, effort);
      await reload();
    },
    [reload],
  );

  const setDirectorProvider = useCallback(
    async (id: string, provider: Provider | null) => {
      await window.api.setProjectDirectorProvider(id, provider);
      await reload();
    },
    [reload],
  );

  const setAutoBranch = useCallback(
    async (id: string, on: boolean) => {
      await window.api.setProjectAutoBranch(id, on);
      await reload();
    },
    [reload],
  );

  const setMcpConfig = useCallback(
    async (id: string, config: string | null) => {
      const res = await window.api.setProjectMcpConfig(id, config);
      if (res.ok) await reload();
      return res;
    },
    [reload],
  );

  const setRoleTools = useCallback(
    async (
      id: string,
      roleTools: Partial<Record<AgentRole, string[]>> | null,
    ) => {
      await window.api.setProjectRoleTools(id, roleTools);
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

  return {
    projects,
    activeId,
    setActive,
    create,
    rename,
    setWorkspace,
    setDirectorModel,
    setDirectorEffort,
    setDirectorProvider,
    setAutoBranch,
    setMcpConfig,
    setRoleTools,
    remove,
    reload,
  };
}
