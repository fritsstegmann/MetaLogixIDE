import { TERMINAL_FONT_SIZE } from '@shared/terminal-font-size';

/** Draft text the terminal-font-size input is currently showing, plus whether it holds an uncommitted edit. */
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

function clamp(n: number): number {
  return Math.min(TERMINAL_FONT_SIZE.max, Math.max(TERMINAL_FONT_SIZE.min, n));
}

/** Starting draft for a freshly mounted or externally reset control: the saved value, not editing. */
export function initialDraft(saved: number): DraftState {
  return { draft: String(saved), editing: false };
}

/** Keystroke/stepper change. A whole number already within range saves immediately; anything else (partial typing, out-of-range, empty) leaves the draft uncommitted. */
export function onInput(raw: string): DraftOutcome {
  const n = parseWholeNumber(raw);
  const commit = n !== null && n === clamp(n) ? n : null;
  return { state: { draft: raw, editing: true }, commit };
}

/** Blur or Enter. A valid whole number clamps into range and saves unless it already matches `saved`; anything else reverts the draft to `saved` with no save. */
export function onCommit(raw: string, saved: number): DraftOutcome {
  const n = parseWholeNumber(raw);
  if (n === null) return { state: { draft: String(saved), editing: false }, commit: null };
  const clamped = clamp(n);
  if (clamped === saved) return { state: { draft: String(saved), editing: false }, commit: null };
  return { state: { draft: String(clamped), editing: false }, commit: clamped };
}

/** Size change from outside the field (keyboard zoom, another window). Replaces the draft unless the field holds an uncommitted edit. */
export function onExternalUpdate(state: DraftState, saved: number): DraftState {
  if (state.editing) return state;
  return { draft: String(saved), editing: false };
}
