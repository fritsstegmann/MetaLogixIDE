import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PEEK_CLOSE_DELAY_MS, PEEK_COPY, createHoverHold, peekClickRequest, resolvePathClick, peekOpenAction, peekOpenRequest, type PeekOpenInput } from '@renderer/peek-open';

const base: PeekOpenInput = { found: true, projectId: 1, currentProjectId: 1, popout: false };

describe('peekOpenAction', () => {
  it.each([false, true])('opens a match in the current project here (popout %s)', (popout) => {
    expect(peekOpenAction({ ...base, popout })).toEqual({ kind: 'open-here' });
  });

  it('switches to another known project from the main window, carrying its id', () => {
    expect(peekOpenAction({ ...base, projectId: 7 })).toEqual({ kind: 'switch-project', projectId: 7 });
  });

  it('disables a match in another project inside a popout, with the main-window note', () => {
    expect(peekOpenAction({ ...base, projectId: 7, popout: true })).toEqual({ kind: 'disabled', note: PEEK_COPY.popoutOtherProject });
  });

  it.each([false, true])('disables a match outside every project with the preview-only note (popout %s)', (popout) => {
    expect(peekOpenAction({ ...base, projectId: null, popout })).toEqual({ kind: 'disabled', note: PEEK_COPY.outsideProjects });
  });

  it('disables a miss silently, whatever projectId says', () => {
    expect(peekOpenAction({ ...base, found: false })).toEqual({ kind: 'disabled', note: null });
    expect(peekOpenAction({ ...base, found: false, projectId: 7 })).toEqual({ kind: 'disabled', note: null });
  });

  it('treats project id 0 as a real project, not as outside', () => {
    expect(peekOpenAction({ ...base, projectId: 0 })).toEqual({ kind: 'switch-project', projectId: 0 });
  });
});

describe('peekOpenRequest', () => {
  it('opens here without a project id so the terminal project is used', () => {
    expect(peekOpenRequest({ kind: 'open-here' }, 'src/a.ts', 12)).toEqual({ relPath: 'src/a.ts', line: 12 });
  });

  it('names the target project when switching', () => {
    expect(peekOpenRequest({ kind: 'switch-project', projectId: 7 }, 'b.ts', null)).toEqual({ relPath: 'b.ts', line: null, projectId: 7 });
  });

  it('sends nothing for a disabled action', () => {
    expect(peekOpenRequest({ kind: 'disabled', note: PEEK_COPY.outsideProjects }, '/abs/x', 3)).toBeNull();
  });
});

describe('peekClickRequest (click on the printed path)', () => {
  const hitHere = { relPath: 'src/a.ts', projectId: 1, found: true };

  it('opens a current-project hit here, with no project id', () => {
    expect(peekClickRequest(hitHere, 4, 1, false)).toEqual({ relPath: 'src/a.ts', line: 4 });
  });

  it('opens the peek-resolved relPath, not the printed path', () => {
    expect(peekClickRequest({ relPath: 'f', projectId: 2, found: true }, null, 1, false)).toEqual({ relPath: 'f', line: null, projectId: 2 });
  });

  it('does nothing for a hit outside every project', () => {
    expect(peekClickRequest({ relPath: '/x/y', projectId: null, found: true }, 1, 1, false)).toBeNull();
  });

  it('does nothing for another project hit in a popout but still opens a same-project one there', () => {
    expect(peekClickRequest({ relPath: 'f', projectId: 2, found: true }, 1, 1, true)).toBeNull();
    expect(peekClickRequest(hitHere, 1, 1, true)).toEqual({ relPath: 'src/a.ts', line: 1 });
  });

  it('does nothing for a miss', () => {
    expect(peekClickRequest({ relPath: 'nope', projectId: null, found: false }, null, 1, false)).toBeNull();
    expect(peekClickRequest({ relPath: 'nope', projectId: 1, found: false }, null, 1, false)).toBeNull();
  });
});

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

describe('resolvePathClick', () => {
  const other = { relPath: 'f', projectId: 2, found: true };

  it('reuses the card peek for the same path without peeking again', async () => {
    const peek = vi.fn();
    await expect(resolvePathClick('/b/f', 3, { currentProjectId: 1, popout: false, cached: { path: '/b/f', peek: other }, peek }))
      .resolves.toEqual({ relPath: 'f', line: 3, projectId: 2 });
    expect(peek).not.toHaveBeenCalled();
  });

  it('peeks afresh when the cached peek is for another path', async () => {
    const peek = vi.fn(async () => ({ relPath: 'g', projectId: 1, found: true }));
    await expect(resolvePathClick('g', null, { currentProjectId: 1, popout: false, cached: { path: '/b/f', peek: other }, peek }))
      .resolves.toEqual({ relPath: 'g', line: null });
    expect(peek).toHaveBeenCalledWith('g');
  });

  it('peeks afresh with no cache and routes by the result', async () => {
    const peek = vi.fn(async () => ({ relPath: '/x', projectId: null, found: true }));
    await expect(resolvePathClick('/x', null, { currentProjectId: 1, popout: false, cached: null, peek })).resolves.toBeNull();
    expect(peek).toHaveBeenCalledTimes(1);
  });

  it('applies the popout rule to the peek result', async () => {
    await expect(resolvePathClick('/b/f', 1, { currentProjectId: 1, popout: true, cached: { path: '/b/f', peek: other }, peek: vi.fn() }))
      .resolves.toBeNull();
  });

  it('opens nothing when the peek fails', async () => {
    const peek = vi.fn(async () => { throw new Error('boom'); });
    await expect(resolvePathClick('a', 1, { currentProjectId: 1, popout: false, cached: null, peek })).resolves.toBeNull();
  });
});
