import { useSyncExternalStore } from 'react';

/** The media query this hook follows. */
export const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

interface ChangeList {
  matches: boolean;
  addEventListener: (type: 'change', cb: () => void) => void;
  removeEventListener: (type: 'change', cb: () => void) => void;
}

/** The `subscribe` / `getSnapshot` pair for `useSyncExternalStore`, over an injectable `matchMedia`. */
export function reducedMotionStore(matchMedia: (query: string) => ChangeList) {
  return {
    subscribe: (onChange: () => void) => {
      const list = matchMedia(REDUCE_QUERY);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    getSnapshot: () => matchMedia(REDUCE_QUERY).matches,
  };
}

const windowStore = typeof window === 'undefined' ? null : reducedMotionStore((q) => window.matchMedia(q));
const never = () => () => undefined;

/**
 * Live `prefers-reduced-motion: reduce`, for the pane folds' `reduced` flag. motion's own
 * `useReducedMotion` snapshots the preference when a component mounts, and the panes' owners
 * (App, ShellSplit) live for the whole session, so an OS setting change would never reach them.
 * Server rendering reports false.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(windowStore?.subscribe ?? never, windowStore?.getSnapshot ?? (() => false), () => false);
}
