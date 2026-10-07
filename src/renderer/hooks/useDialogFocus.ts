import { useCallback, useEffect, type KeyboardEvent, type RefObject } from 'react';
import {
  nextTrapIndex,
  restoreFocus,
  tabbablesWithin,
} from '@renderer/components/settings/dialog-focus';

/**
 * Modal focus for a dialog panel that mounts on open and unmounts on close: on mount it records
 * the opener and focuses `panelRef` (which needs `tabIndex={-1}`); on unmount it restores the
 * opener if still connected. Returns the panel's `onKeyDown`, which wraps Tab and Shift+Tab inside
 * the panel and lets every other key, Escape included, propagate untouched.
 */
export function useDialogFocus(
  panelRef: RefObject<HTMLElement | null>,
): (event: KeyboardEvent<HTMLElement>) => void {
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => restoreFocus(opener);
  }, [panelRef]);

  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const panel = panelRef.current;
      if (event.key !== 'Tab' || event.defaultPrevented || !panel) return;
      event.preventDefault();
      const items = tabbablesWithin<HTMLElement & { disabled?: boolean }>(panel);
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const index = nextTrapIndex(
        items.length,
        active ? items.indexOf(active) : -1,
        event.shiftKey,
      );
      items[index]?.focus();
    },
    [panelRef],
  );
}
