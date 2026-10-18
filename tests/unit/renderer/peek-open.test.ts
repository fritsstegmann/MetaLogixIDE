import { describe, it, expect } from 'vitest';
import { PEEK_COPY, peekOpenAction, peekOpenRequest, type PeekOpenInput } from '@renderer/peek-open';

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
