import { describe, it, expect } from 'vitest';
import {
  nextTrapIndex,
  restoreFocus,
  tabbablesWithin,
  type TabbableCandidate,
} from '@renderer/components/settings/dialog-focus';

describe('nextTrapIndex', () => {
  it('moves forward on Tab', () => {
    expect(nextTrapIndex(4, 1, false)).toBe(2);
  });

  it('moves backward on Shift+Tab', () => {
    expect(nextTrapIndex(4, 2, true)).toBe(1);
  });

  it('wraps from the last focusable to the first on Tab', () => {
    expect(nextTrapIndex(4, 3, false)).toBe(0);
  });

  it('wraps from the first focusable to the last on Shift+Tab', () => {
    expect(nextTrapIndex(4, 0, true)).toBe(3);
  });

  it('stays on the only focusable in both directions', () => {
    expect(nextTrapIndex(1, 0, false)).toBe(0);
    expect(nextTrapIndex(1, 0, true)).toBe(0);
  });

  it('returns -1 when there is nothing to focus', () => {
    expect(nextTrapIndex(0, -1, false)).toBe(-1);
    expect(nextTrapIndex(0, -1, true)).toBe(-1);
  });

  it('sends focus on the panel itself to the first focusable on Tab', () => {
    expect(nextTrapIndex(5, -1, false)).toBe(0);
  });

  it('sends focus on the panel itself to the last focusable on Shift+Tab', () => {
    expect(nextTrapIndex(5, -1, true)).toBe(4);
  });

  it('treats an index past the end as outside the list', () => {
    expect(nextTrapIndex(3, 7, false)).toBe(0);
    expect(nextTrapIndex(3, 7, true)).toBe(2);
  });
});

function candidate(
  name: string,
  overrides: Partial<TabbableCandidate> = {},
): TabbableCandidate & { name: string } {
  return {
    name,
    tabIndex: 0,
    disabled: false,
    getClientRects: () => ({ length: 1 }),
    ...overrides,
  };
}

function root(items: TabbableCandidate[]): {
  selectors: string[];
  querySelectorAll: (s: string) => TabbableCandidate[];
} {
  const selectors: string[] = [];
  return {
    selectors,
    querySelectorAll: (s: string) => {
      selectors.push(s);
      return items;
    },
  };
}

describe('tabbablesWithin', () => {
  it('keeps enabled, rendered elements in the tab order, in document order', () => {
    const a = candidate('a');
    const b = candidate('b');
    expect(tabbablesWithin(root([a, b]))).toEqual([a, b]);
  });

  it('drops elements taken out of the tab order, such as unchecked roving radios', () => {
    const checked = candidate('checked');
    const unchecked = candidate('unchecked', { tabIndex: -1 });
    expect(tabbablesWithin(root([checked, unchecked]))).toEqual([checked]);
  });

  it('drops disabled controls', () => {
    const live = candidate('live');
    const off = candidate('off', { disabled: true });
    expect(tabbablesWithin(root([off, live]))).toEqual([live]);
  });

  it('drops elements that are not rendered', () => {
    const shown = candidate('shown');
    const hidden = candidate('hidden', { getClientRects: () => ({ length: 0 }) });
    expect(tabbablesWithin(root([hidden, shown]))).toEqual([shown]);
  });

  it('queries buttons, inputs and explicitly tabbable elements', () => {
    const r = root([]);
    tabbablesWithin(r);
    const selector = r.selectors.join(',');
    expect(selector).toContain('button');
    expect(selector).toContain('input');
    expect(selector).toContain('[tabindex]');
  });
});

describe('restoreFocus', () => {
  it('focuses the opener when it is still in the document', () => {
    let focused = 0;
    restoreFocus({
      isConnected: true,
      focus: () => {
        focused += 1;
      },
    });
    expect(focused).toBe(1);
  });

  it('leaves focus alone when the opener has been removed', () => {
    let focused = 0;
    restoreFocus({
      isConnected: false,
      focus: () => {
        focused += 1;
      },
    });
    expect(focused).toBe(0);
  });

  it('does nothing when there was no opener', () => {
    expect(() => restoreFocus(null)).not.toThrow();
  });
});
