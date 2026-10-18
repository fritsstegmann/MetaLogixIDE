import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PEEK_CLOSE_DELAY_MS, createHoverHold } from '@renderer/hover-hold';

describe('createHoverHold', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('closes once the delay passes after the pointer leaves the path', () => {
    const close = vi.fn();
    const hold = createHoverHold(close, 200);
    hold.linkEnter();
    hold.linkLeave();
    vi.advanceTimersByTime(199);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('stays open when the card is entered within the delay after leaving the path', () => {
    const close = vi.fn();
    const hold = createHoverHold(close, 200);
    hold.linkEnter();
    hold.linkLeave();
    vi.advanceTimersByTime(150);
    hold.cardEnter();
    vi.advanceTimersByTime(1000);
    expect(close).not.toHaveBeenCalled();
  });

  it('stays open when the card enter arrives before the path leave (pointer events precede mouse events)', () => {
    const close = vi.fn();
    const hold = createHoverHold(close, 200);
    hold.linkEnter();
    hold.cardEnter();
    hold.linkLeave();
    vi.advanceTimersByTime(1000);
    expect(close).not.toHaveBeenCalled();
  });

  it('closes after the pointer leaves the card, unless it returns to the path', () => {
    const close = vi.fn();
    const hold = createHoverHold(close, 200);
    hold.cardEnter();
    hold.linkLeave();
    hold.cardLeave();
    vi.advanceTimersByTime(100);
    hold.linkEnter();
    vi.advanceTimersByTime(1000);
    expect(close).not.toHaveBeenCalled();
    hold.linkLeave();
    vi.advanceTimersByTime(200);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes only once for repeated leaves', () => {
    const close = vi.fn();
    const hold = createHoverHold(close, 200);
    hold.linkLeave();
    vi.advanceTimersByTime(100);
    hold.cardLeave();
    vi.advanceTimersByTime(199);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('drops a pending close on dispose and forgets the pointer was on the card', () => {
    const close = vi.fn();
    const hold = createHoverHold(close, 200);
    hold.cardEnter();
    hold.dispose();
    hold.linkEnter();
    hold.linkLeave();
    vi.advanceTimersByTime(200);
    expect(close).toHaveBeenCalledTimes(1);
    hold.linkLeave();
    hold.dispose();
    vi.advanceTimersByTime(1000);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('defaults to PEEK_CLOSE_DELAY_MS and accepts injected timers', () => {
    const set = vi.fn((): ReturnType<typeof setTimeout> => 7 as unknown as ReturnType<typeof setTimeout>);
    const clear = vi.fn();
    const hold = createHoverHold(() => undefined, undefined, { set, clear });
    hold.linkLeave();
    expect(set).toHaveBeenCalledWith(expect.any(Function), PEEK_CLOSE_DELAY_MS);
    hold.linkEnter();
    expect(clear).toHaveBeenCalledWith(7);
  });
});
