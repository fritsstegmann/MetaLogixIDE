import { describe, it, expect } from 'vitest';
import type { GitSideContent } from '@shared/ipc-contract';
import {
  IDLE_SIDES,
  changesStateFrom,
  changesStateFromFailure,
  createRequestGate,
  diffSidesReducer,
  errorText,
  planSidesRequest,
  type DiffSidesState,
} from '@renderer/diff/diff-load-state';

const side = (text: string): GitSideContent => ({ text });
const okResponse = (diff: string, diffHash: string) =>
  ({ status: 'ok', diff, diffHash, oldSide: side('a'), newSide: side('b') }) as const;
const baseStatus = { isRepo: true, branch: 'main', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] };

describe('createRequestGate', () => {
  it('treats only the newest request as latest', () => {
    const gate = createRequestGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isLatest(first)).toBe(false);
    expect(gate.isLatest(second)).toBe(true);
  });

  it('is in flight from begin until the latest request settles', () => {
    const gate = createRequestGate();
    expect(gate.inFlight).toBe(false);
    const seq = gate.begin();
    expect(gate.inFlight).toBe(true);
    gate.settle(seq);
    expect(gate.inFlight).toBe(false);
  });

  it('stays in flight when a superseded request settles', () => {
    const gate = createRequestGate();
    const old = gate.begin();
    gate.begin();
    gate.settle(old);
    expect(gate.inFlight).toBe(true);
  });

  it('drops every outstanding response after invalidate (unmount on project switch)', () => {
    const gate = createRequestGate();
    const seq = gate.begin();
    gate.invalidate();
    expect(gate.isLatest(seq)).toBe(false);
    expect(gate.inFlight).toBe(false);
  });
});

describe('changesStateFrom', () => {
  it('reports not-repo when the project has no repository', () => {
    expect(changesStateFrom({ ...baseStatus, isRepo: false })).toEqual({ phase: 'not-repo' });
  });

  it('reports the error with git text when status carries one, never ready', () => {
    expect(changesStateFrom({ ...baseStatus, error: 'fatal: not a git repository' })).toEqual({
      phase: 'error',
      message: 'fatal: not a git repository',
    });
  });

  it('reports an error even when git gave no text', () => {
    expect(changesStateFrom({ ...baseStatus, error: '' })).toEqual({ phase: 'error', message: '' });
  });

  it('reports ready with the three lists', () => {
    const res = { ...baseStatus, staged: [{ path: 'a.ts', status: 'M' as const }], untracked: ['u'] };
    expect(changesStateFrom(res)).toEqual({ phase: 'ready', lists: { staged: res.staged, unstaged: [], untracked: ['u'] } });
  });
});

describe('changesStateFromFailure', () => {
  it('keeps the thrown text without the Error prefix', () => {
    expect(changesStateFromFailure(new Error('spawn git ENOENT'))).toEqual({ phase: 'error', message: 'spawn git ENOENT' });
  });
});

describe('errorText', () => {
  it('strips one leading Error: prefix', () => {
    expect(errorText(new Error('EACCES: permission denied'))).toBe('EACCES: permission denied');
  });

  it('stringifies a non-Error value', () => {
    expect(errorText('plain')).toBe('plain');
  });
});

describe('diffSidesReducer', () => {
  const loaded: DiffSidesState = { key: 'unstaged:a.ts', ...okResponse('d1', 'h1') };

  it('shows loading for a new selection', () => {
    expect(diffSidesReducer(loaded, { type: 'select', key: 'staged:b.ts' })).toEqual({ status: 'loading', key: 'staged:b.ts' });
  });

  it('keeps the loaded diff when the same entry is selected again', () => {
    expect(diffSidesReducer(loaded, { type: 'select', key: 'unstaged:a.ts' })).toBe(loaded);
  });

  it('goes idle when nothing is selected', () => {
    expect(diffSidesReducer(loaded, { type: 'select', key: null })).toEqual(IDLE_SIDES);
  });

  it('applies an ok response for the selected entry', () => {
    const loading: DiffSidesState = { status: 'loading', key: 'unstaged:a.ts' };
    expect(diffSidesReducer(loading, { type: 'response', key: 'unstaged:a.ts', response: okResponse('d1', 'h1') })).toEqual(loaded);
  });

  it('returns the same state object for unchanged, so nothing re-renders or shows loading', () => {
    expect(diffSidesReducer(loaded, { type: 'response', key: 'unstaged:a.ts', response: { status: 'unchanged' } })).toBe(loaded);
  });

  it('returns the same state object for an ok response with the same hash', () => {
    expect(diffSidesReducer(loaded, { type: 'response', key: 'unstaged:a.ts', response: okResponse('d1', 'h1') })).toBe(loaded);
  });

  it('replaces the diff in place when the hash changed, without passing through loading', () => {
    const next = diffSidesReducer(loaded, { type: 'response', key: 'unstaged:a.ts', response: okResponse('d2', 'h2') });
    expect(next).toEqual({ key: 'unstaged:a.ts', ...okResponse('d2', 'h2') });
  });

  it('drops a response for an entry that is no longer selected', () => {
    const loading: DiffSidesState = { status: 'loading', key: 'staged:b.ts' };
    expect(diffSidesReducer(loading, { type: 'response', key: 'unstaged:a.ts', response: okResponse('d1', 'h1') })).toBe(loading);
  });

  it('reports too-large', () => {
    const loading: DiffSidesState = { status: 'loading', key: 'untracked:big.txt' };
    expect(diffSidesReducer(loading, { type: 'response', key: 'untracked:big.txt', response: { status: 'too-large' } })).toEqual({
      status: 'too-large',
      key: 'untracked:big.txt',
    });
  });

  it('reports a failure with its text', () => {
    const loading: DiffSidesState = { status: 'loading', key: 'untracked:noperm.txt' };
    expect(diffSidesReducer(loading, { type: 'failure', key: 'untracked:noperm.txt', message: 'EACCES' })).toEqual({
      status: 'error',
      key: 'untracked:noperm.txt',
      message: 'EACCES',
    });
  });

  it('keeps the same object when the same failure repeats on a poll', () => {
    const failed: DiffSidesState = { status: 'error', key: 'untracked:noperm.txt', message: 'EACCES' };
    expect(diffSidesReducer(failed, { type: 'failure', key: 'untracked:noperm.txt', message: 'EACCES' })).toBe(failed);
  });

  it('drops a failure for an entry that is no longer selected', () => {
    expect(diffSidesReducer(loaded, { type: 'failure', key: 'staged:b.ts', message: 'boom' })).toBe(loaded);
  });
});

describe('planSidesRequest', () => {
  const loaded: DiffSidesState = { key: 'unstaged:a.ts', ...okResponse('d1', 'h1') };

  it('sends the shown hash when reloading the shown entry', () => {
    expect(planSidesRequest(loaded, 'unstaged:a.ts', false)).toEqual({ skip: false, extra: { ifDiffHashNot: 'h1' } });
  });

  it('sends no hash for a new selection', () => {
    expect(planSidesRequest(loaded, 'staged:b.ts', false)).toEqual({ skip: false, extra: {} });
  });

  it('sends no hash when the shown entry is in an error state', () => {
    const failed: DiffSidesState = { status: 'error', key: 'unstaged:a.ts', message: 'x' };
    expect(planSidesRequest(failed, 'unstaged:a.ts', false)).toEqual({ skip: false, extra: {} });
  });

  it('skips a reload while a request for the same entry is in flight', () => {
    expect(planSidesRequest(loaded, 'unstaged:a.ts', true)).toEqual({ skip: true });
  });

  it('never skips a new selection, even with a request in flight', () => {
    expect(planSidesRequest(loaded, 'staged:b.ts', true)).toEqual({ skip: false, extra: {} });
  });
});
