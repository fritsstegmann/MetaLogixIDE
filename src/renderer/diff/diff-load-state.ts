/**
 * Pure load-state logic behind the Diff tab hooks: a request-sequence gate that drops superseded
 * responses and reports an in-flight request, the `git:panel-status` → list phase mapping, and the
 * reducer for the selected entry's `git:diff-sides` data, which leaves its state object untouched for
 * an unchanged reload (spec AC17, AC20, AC21, AC23, AC24, AC28–AC30).
 */
import type { GitSideContent, IpcContract } from '@shared/ipc-contract';
import type { ChangeLists } from '@renderer/diff/diff-selection';

type PanelStatusResponse = IpcContract['git:panel-status']['response'];
type DiffSidesResponse = IpcContract['git:diff-sides']['response'];

export interface RequestGate {
  readonly inFlight: boolean;
  begin(): number;
  isLatest(seq: number): boolean;
  settle(seq: number): void;
  invalidate(): void;
}

export type ChangesState =
  | { phase: 'loading' }
  | { phase: 'not-repo' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; lists: ChangeLists };

export type DiffSidesState =
  | { status: 'idle' }
  | { status: 'loading'; key: string }
  | { status: 'ok'; key: string; diff: string; diffHash: string; oldSide: GitSideContent; newSide: GitSideContent }
  | { status: 'too-large'; key: string }
  | { status: 'error'; key: string; message: string };

export type DiffSidesAction =
  | { type: 'select'; key: string | null }
  | { type: 'response'; key: string; response: DiffSidesResponse }
  | { type: 'failure'; key: string; message: string };

export type SidesRequestPlan = { skip: true } | { skip: false; extra: { ifDiffHashNot?: string } };

export const IDLE_SIDES: DiffSidesState = { status: 'idle' };

/** A monotonic request sequence: only the newest request is latest, and `invalidate` makes every outstanding one stale. */
export function createRequestGate(): RequestGate {
  let latest = 0;
  let pending = false;
  return {
    get inFlight() {
      return pending;
    },
    begin() {
      latest += 1;
      pending = true;
      return latest;
    },
    isLatest: (seq) => seq === latest,
    settle(seq) {
      if (seq === latest) pending = false;
    },
    invalidate() {
      latest += 1;
      pending = false;
    },
  };
}

/** The user-facing text of a thrown value, without a leading `Error:` prefix. */
export function errorText(e: unknown): string {
  return String(e).replace(/^Error:\s*/, '');
}

/** Maps a `git:panel-status` response to the list phase; an `error` field always wins over the (empty) lists. */
export function changesStateFrom(res: PanelStatusResponse): ChangesState {
  if (!res.isRepo) return { phase: 'not-repo' };
  if (res.error !== undefined) return { phase: 'error', message: res.error };
  return { phase: 'ready', lists: { staged: res.staged, unstaged: res.unstaged, untracked: res.untracked } };
}

/** The list phase for a `git:panel-status` call that threw. */
export function changesStateFromFailure(e: unknown): ChangesState {
  return { phase: 'error', message: errorText(e) };
}

function applyResponse(state: DiffSidesState, key: string, response: DiffSidesResponse): DiffSidesState {
  if (response.status === 'unchanged') return state;
  if (response.status === 'too-large') return state.status === 'too-large' ? state : { status: 'too-large', key };
  if (state.status === 'ok' && state.diffHash === response.diffHash) return state;
  const { diff, diffHash, oldSide, newSide } = response;
  return { status: 'ok', key, diff, diffHash, oldSide, newSide };
}

/** Selected-entry diff state; every no-op transition returns the same object so React skips the render. */
export function diffSidesReducer(state: DiffSidesState, action: DiffSidesAction): DiffSidesState {
  const shownKey = state.status === 'idle' ? null : state.key;
  if (action.type === 'select') {
    if (action.key === shownKey) return state;
    return action.key === null ? IDLE_SIDES : { status: 'loading', key: action.key };
  }
  if (action.key !== shownKey) return state;
  if (action.type === 'response') return applyResponse(state, action.key, action.response);
  if (state.status === 'error' && state.message === action.message) return state;
  return { status: 'error', key: action.key, message: action.message };
}

/** Whether to request the sides for `key` now, and with which hash: a reload of the shown diff sends its hash, and is skipped while one is in flight. */
export function planSidesRequest(state: DiffSidesState, key: string, inFlight: boolean): SidesRequestPlan {
  const isReload = state.status !== 'idle' && state.key === key;
  if (isReload && inFlight) return { skip: true };
  return { skip: false, extra: isReload && state.status === 'ok' ? { ifDiffHashNot: state.diffHash } : {} };
}
