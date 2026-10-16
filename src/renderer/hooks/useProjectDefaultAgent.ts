/** React adapter for one captured project settings session using the existing typed IPC transport. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Project } from '@shared/types';
import { api } from '@renderer/api';
import { createProjectDefaultAgentStore, type ProjectDefaultAgentSnapshot } from '@renderer/project-default-agent-store';
import type { ProjectSettingsTarget } from '@renderer/project-settings-contract';

interface ProjectDefaultAgentController {
  readonly snapshot: ProjectDefaultAgentSnapshot;
  choose(name: string | null): void;
  replaceCustomCommands(): void;
  retry(): void;
}

/** Owns the mount-only session; the caller keys its container by target ID to start another session. */
export function useProjectDefaultAgent(
  target: ProjectSettingsTarget,
  onSaved: (project: Project) => void,
): ProjectDefaultAgentController {
  const savedRef = useRef(onSaved);
  savedRef.current = onSaved;
  const [store] = useState(() => createProjectDefaultAgentStore(target, {
    loadProject: async (projectId) => {
      const { projects } = await api.invoke('projects:list', undefined);
      const project = projects.find((item) => item.id === projectId);
      if (!project) throw new Error('The target project is no longer available.');
      return project;
    },
    loadProfiles: async (projectId) => {
      const { profiles } = await api.invoke('shells:cli-profiles-list', { projectId });
      return profiles;
    },
    save: async (request) => {
      const { project } = await api.invoke('shells:set-default-cli', request);
      return project;
    },
    onSaved: (project) => savedRef.current(project),
  }));
  useEffect(() => store.connect(), [store]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { snapshot, choose: store.choose, replaceCustomCommands: store.replaceCustomCommands, retry: store.retry };
}
