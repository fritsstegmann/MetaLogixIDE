/**
 * Pure focus-containment helpers for the Settings dialog: which elements take part in the Tab
 * cycle, where Tab and Shift+Tab move next (wrapping at both ends), and restoring focus to the
 * opener on close. Element shapes are structural so the logic unit-tests without a DOM.
 */

const TABBABLE_SELECTOR = 'button, input, select, textarea, a[href], [tabindex]';

/** The slice of an element `tabbablesWithin` needs to decide whether it is in the Tab cycle. */
export interface TabbableCandidate {
  readonly tabIndex: number;
  readonly disabled?: boolean;
  getClientRects(): { readonly length: number };
}

/** The slice of an element `restoreFocus` needs. */
export interface FocusTarget {
  readonly isConnected: boolean;
  focus(): void;
}

/**
 * Index Tab (or Shift+Tab when `shift`) moves to among `count` focusables, wrapping at the ends.
 * An `activeIndex` outside the list (focus on the panel itself) goes to the first on Tab and the
 * last on Shift+Tab; an empty list yields -1.
 */
export function nextTrapIndex(count: number, activeIndex: number, shift: boolean): number {
  if (count === 0) return -1;
  if (activeIndex < 0 || activeIndex >= count) return shift ? count - 1 : 0;
  return (activeIndex + (shift ? count - 1 : 1)) % count;
}

/** Elements under `root` in the Tab order, in document order: enabled, rendered and not `tabindex="-1"`. */
export function tabbablesWithin<T extends TabbableCandidate>(root: {
  querySelectorAll(selector: string): Iterable<T> | ArrayLike<T>;
}): T[] {
  return Array.from(root.querySelectorAll(TABBABLE_SELECTOR)).filter(
    (el) => el.tabIndex >= 0 && el.disabled !== true && el.getClientRects().length > 0,
  );
}

/** Focuses `target` if it is still in the document; otherwise leaves focus where it is. */
export function restoreFocus(target: FocusTarget | null): void {
  if (target?.isConnected) target.focus();
}
