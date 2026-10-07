import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTerminalGeometryHold, HOLD_WATCHDOG_MS } from '@renderer/terminal-geometry-hold';

describe('terminal geometry hold', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('is not held until someone holds it', () => {
    const g = createTerminalGeometryHold();
    expect(g.isHeld()).toBe(false);
    g.hold();
    expect(g.isHeld()).toBe(true);
  });

  it('is ref-counted: two holds and one release stay held', () => {
    const g = createTerminalGeometryHold();
    const a = g.hold();
    const b = g.hold();
    a();
    expect(g.isHeld()).toBe(true);
    b();
    expect(g.isHeld()).toBe(false);
  });

  it('treats a repeated release as a no-op', () => {
    const g = createTerminalGeometryHold();
    const a = g.hold();
    const b = g.hold();
    a();
    a();
    expect(g.isHeld()).toBe(true);
    b();
    expect(g.isHeld()).toBe(false);
  });

  it('notifies once on the transition to zero, not on each release', () => {
    const g = createTerminalGeometryHold();
    const cb = vi.fn();
    g.onRelease(cb);
    const a = g.hold();
    const b = g.hold();
    a();
    expect(cb).not.toHaveBeenCalled();
    b();
    b();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('auto-releases after the 1000ms watchdog and notifies', () => {
    expect(HOLD_WATCHDOG_MS).toBe(1000);
    const g = createTerminalGeometryHold();
    const cb = vi.fn();
    g.onRelease(cb);
    const release = g.hold();
    vi.advanceTimersByTime(HOLD_WATCHDOG_MS - 1);
    expect(g.isHeld()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(g.isHeld()).toBe(false);
    expect(cb).toHaveBeenCalledTimes(1);
    release();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("a released hold's watchdog never cuts a later hold short", () => {
    const g = createTerminalGeometryHold();
    const cb = vi.fn();
    g.onRelease(cb);
    g.hold()();
    vi.advanceTimersByTime(HOLD_WATCHDOG_MS / 2);
    g.hold();
    vi.advanceTimersByTime(HOLD_WATCHDOG_MS * 0.6);
    expect(g.isHeld()).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HOLD_WATCHDOG_MS * 0.4);
    expect(g.isHeld()).toBe(false);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('a new hold restarts the watchdog for every outstanding hold', () => {
    const g = createTerminalGeometryHold();
    const cb = vi.fn();
    g.onRelease(cb);
    g.hold();
    vi.advanceTimersByTime(HOLD_WATCHDOG_MS / 2);
    g.hold();
    vi.advanceTimersByTime(HOLD_WATCHDOG_MS / 2);
    expect(g.isHeld()).toBe(true);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(HOLD_WATCHDOG_MS / 2);
    expect(g.isHeld()).toBe(false);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('renew restarts the watchdog, so a chain of toggles keeps its hold', () => {
    const g = createTerminalGeometryHold();
    const cb = vi.fn();
    g.onRelease(cb);
    g.hold();
    vi.advanceTimersByTime(HOLD_WATCHDOG_MS * 0.8);
    g.renew();
    vi.advanceTimersByTime(HOLD_WATCHDOG_MS * 0.7);
    expect(g.isHeld()).toBe(true);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(HOLD_WATCHDOG_MS * 0.3);
    expect(g.isHeld()).toBe(false);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('renew without a hold does nothing', () => {
    const g = createTerminalGeometryHold();
    const cb = vi.fn();
    g.onRelease(cb);
    g.renew();
    vi.advanceTimersByTime(HOLD_WATCHDOG_MS * 2);
    expect(g.isHeld()).toBe(false);
    expect(cb).not.toHaveBeenCalled();
  });

  it('a release from before the watchdog fired cannot end a later hold', () => {
    const g = createTerminalGeometryHold();
    const stale = g.hold();
    vi.advanceTimersByTime(HOLD_WATCHDOG_MS);
    g.hold();
    stale();
    expect(g.isHeld()).toBe(true);
  });

  it('stops notifying after unsubscribe', () => {
    const g = createTerminalGeometryHold();
    const cb = vi.fn();
    const off = g.onRelease(cb);
    off();
    g.hold()();
    expect(cb).not.toHaveBeenCalled();
  });
});
