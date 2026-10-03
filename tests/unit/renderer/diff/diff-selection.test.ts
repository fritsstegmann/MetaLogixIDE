import { describe, it, expect } from 'vitest';
import {
  diffTabCount,
  entryKey,
  flattenChanges,
  groupChanges,
  reconcileSelection,
  sidesRequestFor,
  type ChangeLists,
  type DiffEntry,
} from '@renderer/diff/diff-selection';

const lists: ChangeLists = {
  staged: [
    { path: 'b.ts', status: 'M' },
    { path: 'new name é.js', status: 'R', origPath: 'old.ts' },
  ],
  unstaged: [
    { path: 'b.ts', status: 'M' },
    { path: 'gone.ts', status: 'D' },
  ],
  untracked: ['dir/sub/u1.txt', 'dir/u2.txt'],
};

const empty: ChangeLists = { staged: [], unstaged: [], untracked: [] };

describe('groupChanges', () => {
  it('orders the groups staged, unstaged, untracked', () => {
    expect(groupChanges(lists).map((g) => g.group)).toEqual(['staged', 'unstaged', 'untracked']);
  });

  it('drops empty groups', () => {
    const groups = groupChanges({ staged: [], unstaged: [], untracked: ['x'] });
    expect(groups.map((g) => g.group)).toEqual(['untracked']);
  });

  it('returns no groups for a clean tree', () => {
    expect(groupChanges(empty)).toEqual([]);
  });

  it('lists each untracked file individually with status ?', () => {
    const untracked = groupChanges(lists).find((g) => g.group === 'untracked');
    expect(untracked?.entries).toEqual([
      { group: 'untracked', path: 'dir/sub/u1.txt', status: '?' },
      { group: 'untracked', path: 'dir/u2.txt', status: '?' },
    ]);
  });

  it('keeps the rename origPath on the staged entry', () => {
    const staged = groupChanges(lists)[0];
    expect(staged?.entries[1]).toEqual({ group: 'staged', path: 'new name é.js', status: 'R', origPath: 'old.ts' });
  });
});

describe('flattenChanges', () => {
  it('lists a path present in two groups twice, in group order', () => {
    const rows = flattenChanges(lists).map((e) => `${e.group}:${e.path}`);
    expect(rows).toEqual([
      'staged:b.ts',
      'staged:new name é.js',
      'unstaged:b.ts',
      'unstaged:gone.ts',
      'untracked:dir/sub/u1.txt',
      'untracked:dir/u2.txt',
    ]);
  });

  it('lists a conflicted path in both staged and unstaged', () => {
    const rows = flattenChanges({ staged: [{ path: 'c.ts', status: 'U' }], unstaged: [{ path: 'c.ts', status: 'U' }], untracked: [] });
    expect(rows.map((e) => e.group)).toEqual(['staged', 'unstaged']);
  });
});

describe('entryKey', () => {
  it('differs for the same path in different groups', () => {
    const [stagedB, , unstagedB] = flattenChanges(lists);
    expect(entryKey(stagedB as DiffEntry)).not.toBe(entryKey(unstagedB as DiffEntry));
  });
});

describe('reconcileSelection', () => {
  const entries = flattenChanges(lists);
  const unstagedB = entries[2] as DiffEntry;

  it('selects the first entry of the first non-empty group when nothing is selected', () => {
    expect(reconcileSelection(null, entries)).toEqual(entries[0]);
  });

  it('keeps the selection when the same group still has the path', () => {
    expect(reconcileSelection(entryKey(unstagedB), entries)).toEqual(unstagedB);
  });

  it('returns the refreshed entry, not a stale copy', () => {
    const refreshed = flattenChanges({ ...lists, unstaged: [{ path: 'b.ts', status: 'D' }] });
    expect(reconcileSelection(entryKey(unstagedB), refreshed)).toEqual({ group: 'unstaged', path: 'b.ts', status: 'D' });
  });

  it('treats the same path in a different group as gone and falls back to the first entry', () => {
    const afterStaging = flattenChanges({ staged: [{ path: 'gone.ts', status: 'D' }, { path: 'b.ts', status: 'M' }], unstaged: [], untracked: ['dir/u2.txt'] });
    expect(reconcileSelection(entryKey(unstagedB), afterStaging)).toEqual({ group: 'staged', path: 'gone.ts', status: 'D' });
  });

  it('clears the selection when no entries remain', () => {
    expect(reconcileSelection(entryKey(unstagedB), [])).toBeNull();
  });

  it('stays empty when nothing is selected and there are no entries', () => {
    expect(reconcileSelection(null, [])).toBeNull();
  });
});

describe('sidesRequestFor', () => {
  it('maps a staged entry to the staged kind', () => {
    expect(sidesRequestFor({ group: 'staged', path: 'a.ts', status: 'M' })).toEqual({ kind: 'staged', path: 'a.ts' });
  });

  it('maps an unstaged entry to the unstaged kind', () => {
    expect(sidesRequestFor({ group: 'unstaged', path: 'a.ts', status: 'M' })).toEqual({ kind: 'unstaged', path: 'a.ts' });
  });

  it('maps an untracked entry to the untracked kind', () => {
    expect(sidesRequestFor({ group: 'untracked', path: 'dir/u2.txt', status: '?' })).toEqual({ kind: 'untracked', path: 'dir/u2.txt' });
  });

  it('passes the rename origPath through', () => {
    expect(sidesRequestFor({ group: 'staged', path: 'new name é.js', status: 'R', origPath: 'old.ts' })).toEqual({
      kind: 'staged',
      path: 'new name é.js',
      origPath: 'old.ts',
    });
  });
});

describe('diffTabCount', () => {
  it('counts unique changed paths, not listed rows', () => {
    expect(diffTabCount({ isRepo: true, files: { 'b.ts': 'M', 'c.ts': 'U', 'dir/u2.txt': '?' } })).toBe(3);
  });

  it('shows no number for a clean repository', () => {
    expect(diffTabCount({ isRepo: true, files: {} })).toBeNull();
  });

  it('shows no number when the project is not a repository', () => {
    expect(diffTabCount({ isRepo: false, files: { 'stale.ts': 'M' } })).toBeNull();
  });
});
