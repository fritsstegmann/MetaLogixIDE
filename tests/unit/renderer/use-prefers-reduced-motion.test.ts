import { describe, expect, it, vi } from 'vitest';
import { REDUCE_QUERY, reducedMotionStore } from '@renderer/hooks/usePrefersReducedMotion';

function fakeMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const list = {
    matches: initial,
    addEventListener: (_: 'change', cb: () => void) => { listeners.add(cb); },
    removeEventListener: (_: 'change', cb: () => void) => { listeners.delete(cb); },
  };
  const matchMedia = vi.fn<(query: string) => typeof list>(() => list);
  const flip = (next: boolean) => { list.matches = next; for (const cb of [...listeners]) cb(); };
  return { matchMedia, flip, listeners };
}

describe('reducedMotionStore', () => {
  it('queries prefers-reduced-motion: reduce', () => {
    const m = fakeMedia(false);
    reducedMotionStore(m.matchMedia).getSnapshot();
    expect(REDUCE_QUERY).toBe('(prefers-reduced-motion: reduce)');
    expect(m.matchMedia).toHaveBeenCalledWith(REDUCE_QUERY);
  });

  it('reads the current preference, not the one at creation', () => {
    const m = fakeMedia(false);
    const store = reducedMotionStore(m.matchMedia);
    expect(store.getSnapshot()).toBe(false);
    m.flip(true);
    expect(store.getSnapshot()).toBe(true);
  });

  it('notifies subscribers when the preference changes', () => {
    const m = fakeMedia(false);
    const store = reducedMotionStore(m.matchMedia);
    const cb = vi.fn();
    store.subscribe(cb);
    m.flip(true);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('stops notifying after unsubscribe', () => {
    const m = fakeMedia(false);
    const store = reducedMotionStore(m.matchMedia);
    const cb = vi.fn();
    store.subscribe(cb)();
    m.flip(true);
    expect(cb).not.toHaveBeenCalled();
    expect(m.listeners.size).toBe(0);
  });
});
