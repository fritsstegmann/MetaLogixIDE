/**
 * Pure load-state logic behind the Diff tab hooks: a request-sequence gate that drops superseded
 * responses and reports an in-flight request, the `git:panel-status` → list phase mapping, and the
 * reducer for the selected entry's `git:diff-sides` data, which leaves its state object untouched for
 * an unchanged reload, and the request plan, which reads the full sides again while a shown side does not
 * match its diff or on a manual refresh (spec AC17, AC20, AC21, AC23, AC24, AC28–AC30, AC38).
 */
import type { GitSideContent, IpcContract } from '@shared/ipc-contract';
import type { ChangeLists } from '@renderer/diff/diff-selection';
import { parseUnifiedDiff } from '@renderer/diff/unified-diff';
import { alignHunks, sideMatchesContent } from '@renderer/diff/diff-rows';

type PanelStatusResponse = IpcContract['git:panel-status']['response'];
type DiffSidesResponse = IpcContract['git:diff-sides']['response'];
type OkSides = Extract<DiffSidesState, { status: 'ok' }>;

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

function sameSide(a: GitSideContent, b: GitSideContent): boolean {
  return a.text === b.text && a.skipped === b.skipped;
}

function sameOk(state: OkSides, response: Extract<DiffSidesResponse, { status: 'ok' }>): boolean {
  return state.diffHash === response.diffHash && sameSide(state.oldSide, response.oldSide) && sameSide(state.newSide, response.newSide);
}

function applyResponse(state: DiffSidesState, key: string, response: DiffSidesResponse): DiffSidesState {
  if (response.status === 'unchanged') return state;
  if (response.status === 'too-large') return state.status === 'too-large' ? state : { status: 'too-large', key };
  if (state.status === 'ok' && sameOk(state, response)) return state;
  const { diff, diffHash, oldSide, newSide } = response;
  return { status: 'ok', key, diff, diffHash, oldSide, newSide };
}

function selectTransition(state: DiffSidesState, shownKey: string | null, key: string | null): DiffSidesState {
  if (key === shownKey) return state;
  return key === null ? IDLE_SIDES : { status: 'loading', key };
}

function applyFailure(state: DiffSidesState, key: string, message: string): DiffSidesState {
  if (state.status === 'error' && state.message === message) return state;
  return { status: 'error', key, message };
}

/** Selected-entry diff state; every no-op transition returns the same object so React skips the render. */
export function diffSidesReducer(state: DiffSidesState, action: DiffSidesAction): DiffSidesState {
  const shownKey = state.status === 'idle' ? null : state.key;
  if (action.type === 'select') return selectTransition(state, shownKey, action.key);
  if (action.key !== shownKey) return state;
  if (action.type === 'response') return applyResponse(state, action.key, action.response);
  return applyFailure(state, action.key, action.message);
}

const sidesMatchCache = new WeakMap<OkSides, boolean>();

/** Whether every shown side with content matches the diff (AC38), memoised per state object so a poll does not re-parse an unchanged diff. */
function sidesMatchDiff(state: OkSides): boolean {
  const cached = sidesMatchCache.get(state);
  if (cached !== undefined) return cached;
  const rows = alignHunks(parseUnifiedDiff(state.diff).hunks);
  const { text: oldText } = state.oldSide;
  const { text: newText } = state.newSide;
  const matches = (oldText === null || sideMatchesContent(rows, 'left', oldText)) && (newText === null || sideMatchesContent(rows, 'right', newText));
  sidesMatchCache.set(state, matches);
  return matches;
}

/**
 * Whether to request the sides for `key` now, and with which hash. A quiet reload of the shown diff sends its hash
 * and is skipped while one is in flight; a manual refresh (`force`), or a shown side that failed the content check,
 * sends no hash so the full sides are read again.
 */
export function planSidesRequest(state: DiffSidesState, key: string, inFlight: boolean, force = false): SidesRequestPlan {
  const isReload = state.status !== 'idle' && state.key === key;
  if (isReload && inFlight && !force) return { skip: true };
  const quiet = isReload && !force && state.status === 'ok' && sidesMatchDiff(state);
  return { skip: false, extra: quiet ? { ifDiffHashNot: state.diffHash } : {} };
}
