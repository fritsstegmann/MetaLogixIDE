import { useEffect, useState } from 'react';
import { api } from '@renderer/api';

/**
 * Number of discovered tasks for the ActivityBar pip. The count is keyed by project, so it reads 0 the
 * moment `projectId` changes and a reply for a previous project is dropped; a failed discovery gives 0.
 * Discovery runs in an effect, so rendering never waits on it.
 */
export function useTaskCount(projectId: number | null): number {
  const [state, setState] = useState<{ projectId: number | null; count: number }>({ projectId: null, count: 0 });
  useEffect(() => {
    if (projectId == null) return;
    let cancelled = false;
    api.invoke('tasks:discover', { projectId }).then(
      ({ tasks }) => { if (!cancelled) setState({ projectId, count: tasks.length }); },
      () => { if (!cancelled) setState({ projectId, count: 0 }); },
    );
    return () => { cancelled = true; };
  }, [projectId]);
  return state.projectId === projectId && projectId != null ? state.count : 0;
}
