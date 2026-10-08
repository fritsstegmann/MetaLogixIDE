/**
 * Per-row reveal timers for masked env values: each revealed key masks itself
 * again after `timeoutMs`, independently of every other key.
 */

/** How long a revealed value stays visible (D1). */
export const REVEAL_TIMEOUT_MS = 39_000;

/** Callers namespace keys: `row:<EnvRow.key>` for editable rows, `app:<name>` for inherited rows. */
export type RevealKey = string;

export interface RevealTimers {
  toggle(key: RevealKey): void;
  isRevealed(key: RevealKey): boolean;
  clearAll(): void;
}

export interface RevealTimersOptions {
  timeoutMs?: number;
  onChange: () => void;
}

export function createRevealTimers(opts: RevealTimersOptions): RevealTimers {
  void opts;
  throw new Error('createRevealTimers not implemented');
}
