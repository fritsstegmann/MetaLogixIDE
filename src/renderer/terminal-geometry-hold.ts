/**
 * A window-wide hold on terminal refits. While a pane fold is in flight the terminals beside it
 * must not fit per frame (each fit is a pty resize), so ShellTab skips its passive geometry syncs
 * while held and runs one sync when the last hold is released. Holds are ref-counted, each release
 * is idempotent, and a watchdog releases any hold after HOLD_WATCHDOG_MS so a lost release can
 * never freeze terminal geometry.
 */

/** Longest a single hold may last before it releases itself. */
export const HOLD_WATCHDOG_MS = 1000;

/** The hold's surface: take a hold (returns its release), query it, and subscribe to the release to zero. */
export interface TerminalGeometryHold {
  hold: () => () => void;
  isHeld: () => boolean;
  onRelease: (cb: () => void) => () => void;
}

/** Creates an independent hold; the app uses the shared instance exported below. */
export function createTerminalGeometryHold(): TerminalGeometryHold {
  let count = 0;
  const listeners = new Set<() => void>();

  function hold(): () => void {
    let released = false;
    count += 1;
    const watchdog = setTimeout(release, HOLD_WATCHDOG_MS);
    function release() {
      if (released) return;
      released = true;
      clearTimeout(watchdog);
      count -= 1;
      if (count === 0) for (const cb of [...listeners]) cb();
    }
    return release;
  }

  return {
    hold,
    isHeld: () => count > 0,
    onRelease: (cb) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  };
}

const shared = createTerminalGeometryHold();

/** Takes a hold on every terminal's geometry; call the returned function to release it. */
export const holdTerminalGeometry = shared.hold;
/** True while any hold is active. */
export const isTerminalGeometryHeld = shared.isHeld;
/** Subscribes to the last hold's release; returns the unsubscribe. */
export const onTerminalGeometryRelease = shared.onRelease;
