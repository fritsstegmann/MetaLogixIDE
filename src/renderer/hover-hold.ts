/**
 * Keeps a terminal path's hover preview open while the pointer travels from the path onto the card. xterm reports
 * leaving the path when the pointer moves onto the card (it sits outside the terminal screen), so the close is delayed
 * and cancelled by the card's own pointer enter. Pure apart from injectable timers.
 */

/** How long the preview stays up after the pointer leaves the path or the card, so it can cross the gap between them. */
export const PEEK_CLOSE_DELAY_MS = 200;

/** Timer functions {@link createHoverHold} schedules with; injectable so the hold is tested without real time. */
export interface HoldTimers {
  set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (handle: ReturnType<typeof setTimeout>) => void;
}

/** Keeps the preview open while the pointer is on the path or the card; `dispose` drops any pending close and resets both. */
export interface HoverHold {
  linkEnter: () => void;
  linkLeave: () => void;
  cardEnter: () => void;
  cardLeave: () => void;
  dispose: () => void;
}

/**
 * Creates the hold that closes the preview only once the pointer is on neither the path nor the card: `close` runs
 * `delayMs` after the pointer leaves the last of them, and entering either cancels it. Tracking both separately keeps
 * the card open whatever order the browser fires the card's pointerenter and xterm's mouseleave-driven link leave.
 */
export function createHoverHold(
  close: () => void,
  delayMs: number = PEEK_CLOSE_DELAY_MS,
  timers: HoldTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) },
): HoverHold {
  let pending: ReturnType<typeof setTimeout> | null = null;
  let overLink = false;
  let overCard = false;
  const cancel = () => {
    if (pending !== null) timers.clear(pending);
    pending = null;
  };
  const update = () => {
    cancel();
    if (overLink || overCard) return;
    pending = timers.set(() => { pending = null; close(); }, delayMs);
  };
  return {
    linkEnter: () => { overLink = true; update(); },
    linkLeave: () => { overLink = false; update(); },
    cardEnter: () => { overCard = true; update(); },
    cardLeave: () => { overCard = false; update(); },
    dispose: () => { overLink = false; overCard = false; cancel(); },
  };
}
