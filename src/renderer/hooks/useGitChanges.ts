import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@renderer/api';
import {
  changesStateFrom,
  changesStateFromFailure,
  createRequestGate,
  type ChangesState,
} from '@renderer/diff/diff-load-state';

export interface GitChanges {
  state: ChangesState;
  /** Bumped on every applied list response (poll or refresh), so the selected diff reloads with it. */
  reloadToken: number;
  refresh: () => void;
}

/**
 * Polls `git:panel-status` for the Diff tab every `intervalMs` while mounted (spec AC21, AC24): a poll tick
 * is skipped while a request is in flight, `refresh()` always starts a fresh request, and a response that a
 * newer request or an unmount has superseded is dropped (AC29). The body is keyed by project, so a project
 * switch is an unmount.
 */
export function useGitChanges(projectId: number, intervalMs = 3000): GitChanges {
  const [state, setState] = useState<ChangesState>({ phase: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);
  const gateRef = useRef(createRequestGate());

  const load = useCallback(
    async (fromPoll: boolean) => {
      const gate = gateRef.current;
      if (fromPoll && gate.inFlight) return;
      const seq = gate.begin();
      try {
        const next = changesStateFrom(await api.invoke('git:panel-status', { projectId }));
        if (gate.isLatest(seq)) setState(next);
      } catch (e) {
        if (gate.isLatest(seq)) setState(changesStateFromFailure(e));
      } finally {
        if (gate.isLatest(seq)) setReloadToken((t) => t + 1);
        gate.settle(seq);
      }
    },
    [projectId],
  );

  useEffect(() => {
    const gate = gateRef.current;
    void load(false);
    const id = window.setInterval(() => void load(true), intervalMs);
    return () => {
      window.clearInterval(id);
      gate.invalidate();
    };
  }, [load, intervalMs]);

  const refresh = useCallback(() => void load(false), [load]);
  return { state, reloadToken, refresh };
}
