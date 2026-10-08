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
  const timeoutMs = opts.timeoutMs ?? REVEAL_TIMEOUT_MS;
  const timers = new Map<RevealKey, ReturnType<typeof setTimeout>>();

  function hide(key: RevealKey) {
    const timer = timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(key);
    }
  }

  return {
    toggle(key: RevealKey) {
      if (timers.has(key)) {
        hide(key);
      } else {
        timers.set(key, setTimeout(() => {
          timers.delete(key);
          opts.onChange();
        }, timeoutMs));
      }
      opts.onChange();
    },
    isRevealed(key: RevealKey) {
      return timers.has(key);
    },
    clearAll() {
      for (const key of [...timers.keys()]) hide(key);
    },
  };
}
