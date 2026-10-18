import { describe, it, expect, vi } from 'vitest';
import { PEEK_COPY, peekClickRequest, resolvePathClick, peekOpenAction, peekOpenRequest, type PeekOpenInput } from '@renderer/peek-open';

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

describe('resolvePathClick', () => {
  it('peeks the clicked path at click time and routes by the result', async () => {
    const peek = vi.fn(async () => ({ relPath: 'f', projectId: 2, found: true }));
    await expect(resolvePathClick('/b/f', 3, { currentProjectId: 1, popout: false, peek })).resolves.toEqual({ relPath: 'f', line: 3, projectId: 2 });
    expect(peek).toHaveBeenCalledWith('/b/f');
  });

  it('opens a current-project hit here', async () => {
    const peek = vi.fn(async () => ({ relPath: 'g', projectId: 1, found: true }));
    await expect(resolvePathClick('g', null, { currentProjectId: 1, popout: false, peek })).resolves.toEqual({ relPath: 'g', line: null });
  });

  it('opens nothing for a hit outside every project', async () => {
    const peek = vi.fn(async () => ({ relPath: '/x', projectId: null, found: true }));
    await expect(resolvePathClick('/x', null, { currentProjectId: 1, popout: false, peek })).resolves.toBeNull();
  });

  it('applies the popout rule to the peek result', async () => {
    const peek = vi.fn(async () => ({ relPath: 'f', projectId: 2, found: true }));
    await expect(resolvePathClick('/b/f', 1, { currentProjectId: 1, popout: true, peek })).resolves.toBeNull();
  });

  it('opens nothing when the peek fails', async () => {
    const peek = vi.fn(async () => { throw new Error('boom'); });
    await expect(resolvePathClick('a', 1, { currentProjectId: 1, popout: false, peek })).resolves.toBeNull();
  });
});
