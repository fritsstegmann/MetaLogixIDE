/**
 * A window-wide hold on terminal refits. While a pane fold is in flight the terminals beside it
 * must not fit per frame (each fit is a pty resize), so ShellTab skips its passive geometry syncs
 * while held and runs one sync when the last hold is released. Holds are ref-counted and each
 * release is idempotent. One watchdog covers all holds: it restarts on every `hold` and `renew`
 * (a chain of toggles renews it), and when it fires it releases every outstanding hold, so a lost
 * release can never freeze terminal geometry for more than HOLD_WATCHDOG_MS.
 */

/** Longest the geometry stays held without a new hold or renew. */
export const HOLD_WATCHDOG_MS = 1000;

/** The hold's surface: take a hold (returns its release), renew the watchdog, query, subscribe to the release to zero. */
export interface TerminalGeometryHold {
  hold: () => () => void;
  renew: () => void;
  isHeld: () => boolean;
  onRelease: (cb: () => void) => () => void;
}

/** Creates an independent hold; the app uses the shared instance exported below. */
export function createTerminalGeometryHold(): TerminalGeometryHold {
  let count = 0;
  let generation = 0;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  function releaseAll() {
    clearTimeout(watchdog);
    count = 0;
    generation += 1;
    for (const cb of [...listeners]) cb();
  }

  function startWatchdog() {
    clearTimeout(watchdog);
    watchdog = setTimeout(releaseAll, HOLD_WATCHDOG_MS);
  }

  function hold(): () => void {
    const holdGeneration = generation;
    let released = false;
    count += 1;
    startWatchdog();
    return () => {
      if (released || holdGeneration !== generation) return;
      released = true;
      count -= 1;
      if (count === 0) releaseAll();
    };
  }

  return {
    hold,
    renew: () => { if (count > 0) startWatchdog(); },
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
/** Restarts the watchdog of the current holds, if any; a pane toggle mid-fold calls it. */
export const renewTerminalGeometryHold = shared.renew;
/** True while any hold is active. */
export const isTerminalGeometryHeld = shared.isHeld;
/** Subscribes to the last hold's release; returns the unsubscribe. */
export const onTerminalGeometryRelease = shared.onRelease;
