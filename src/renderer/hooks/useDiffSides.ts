import { useEffect, useReducer, useRef } from 'react';
import { api } from '@renderer/api';
import { entryKey, sidesRequestFor, type DiffEntry } from '@renderer/diff/diff-selection';
import {
  IDLE_SIDES,
  createRequestGate,
  diffSidesReducer,
  errorText,
  planSidesRequest,
  type DiffSidesState,
} from '@renderer/diff/diff-load-state';

/**
 * Loads `git:diff-sides` for the selected Diff tab entry (spec AC17, AC20, AC23, AC30). A new selection
 * shows loading; each `reloadToken` bump reloads quietly with `ifDiffHashNot`, and an `unchanged` or
 * identical response leaves the state object untouched, so nothing re-renders. Superseded responses are
 * dropped.
 */
export function useDiffSides(projectId: number, entry: DiffEntry | null, reloadToken: number): DiffSidesState {
  const [state, dispatch] = useReducer(diffSidesReducer, IDLE_SIDES);
  const stateRef = useRef(state);
  stateRef.current = state;
  const gateRef = useRef(createRequestGate());
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const key = entry ? entryKey(entry) : null;
  const origPath = entry?.origPath;

  useEffect(() => {
    dispatch({ type: 'select', key });
  }, [key]);

  useEffect(() => {
    const current = entryRef.current;
    if (!current || key === null) return;
    const gate = gateRef.current;
    const plan = planSidesRequest(stateRef.current, key, gate.inFlight);
    if (plan.skip) return;
    const seq = gate.begin();
    api
      .invoke('git:diff-sides', { projectId, ...sidesRequestFor(current), ...plan.extra })
      .then((response) => {
        if (gate.isLatest(seq)) dispatch({ type: 'response', key, response });
      })
      .catch((e: unknown) => {
        if (gate.isLatest(seq)) dispatch({ type: 'failure', key, message: errorText(e) });
      })
      .finally(() => gate.settle(seq));
  }, [projectId, key, origPath, reloadToken]);

  useEffect(() => {
    const gate = gateRef.current;
    return () => gate.invalidate();
  }, []);

  return state;
}
