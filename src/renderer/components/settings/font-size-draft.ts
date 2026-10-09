import { clampTerminalFontSize, stepTerminalFontSize } from '@shared/terminal-font-size';

/** Draft text the terminal-font-size input is currently showing, plus whether it holds an uncommitted edit (typed text not yet resolved by blur or Enter). */
export interface DraftState {
  readonly draft: string;
  readonly editing: boolean;
}

/** Result of a draft transition: the next state and the value to save, or `null` to save nothing. */
export interface DraftOutcome {
  readonly state: DraftState;
  readonly commit: number | null;
}

function parseWholeNumber(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

/** Starting draft for a freshly mounted or externally reset control: the saved value, not editing. */
export function initialDraft(saved: number): DraftState {
  return { draft: String(saved), editing: false };
}

/** Keystroke change (AC2 amendment): typed text never saves while typing. It only updates the visible draft and marks the field as holding an uncommitted edit, so an external update (e.g. a revert after a failed save) is held off until blur or Enter resolves it. */
export function onInput(raw: string): DraftOutcome {
  return { state: { draft: raw, editing: true }, commit: null };
}

/** Blur or Enter. A valid whole number clamps into range and saves unless it already matches `saved`; anything else (empty, non-numeric, non-integer) reverts the draft to `saved` with no save. Either way the edit is now resolved, so `editing` is false. */
export function onCommit(raw: string, saved: number): DraftOutcome {
  const n = parseWholeNumber(raw);
  if (n === null) return { state: { draft: String(saved), editing: false }, commit: null };
  const clamped = clampTerminalFontSize(n);
  if (clamped === saved) return { state: { draft: String(saved), editing: false }, commit: null };
  return { state: { draft: String(clamped), editing: false }, commit: clamped };
}

/** Arrow key or stepper button (AC2): saves immediately, clamped at the bounds (no-op at a bound). Resolved immediately, so `editing` is false — it never blocks a later external update the way a held-open typed edit would. */
export function onStep(current: number, direction: 'in' | 'out'): DraftOutcome {
  const next = stepTerminalFontSize(current, direction);
  if (next === current) return { state: { draft: String(current), editing: false }, commit: null };
  return { state: { draft: String(next), editing: false }, commit: next };
}

/** Size change from outside the field (keyboard zoom, another window, or a reverted failed save). Replaces the draft unless the field holds an uncommitted typed edit. */
export function onExternalUpdate(state: DraftState, saved: number): DraftState {
  if (state.editing) return state;
  return { draft: String(saved), editing: false };
}
