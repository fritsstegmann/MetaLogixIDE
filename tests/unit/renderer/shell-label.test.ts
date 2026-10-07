import { describe, expect, it } from 'vitest';
import { hiddenUntilListChanges, shellChipLabel, stripShells } from '@renderer/shell-label';

const shells = [
  { shellIndex: 0, launchName: 'Claude' },
  { shellIndex: 1, launchName: 'Terminal' },
  { shellIndex: 3, launchName: 'Terminal' },
];

describe('shellChipLabel', () => {
  it('returns the bare launch name when it is unique', () => {
    expect(shellChipLabel(shells, 0)).toBe('Claude');
  });

  it('suffixes duplicate names by their order in the list, not their shell index', () => {
    expect(shellChipLabel(shells, 1)).toBe('Terminal 1');
    expect(shellChipLabel(shells, 3)).toBe('Terminal 2');
  });

  it('returns an empty string for an index not in the list', () => {
    expect(shellChipLabel(shells, 2)).toBe('');
  });
});

describe('stripShells', () => {
  it('leaves out the split right shell and keeps every other shell in order', () => {
    expect(stripShells(shells, 1).map((s) => s.shellIndex)).toEqual([0, 3]);
  });

  it('shows every shell when no split is open', () => {
    expect(stripShells(shells, null).map((s) => s.shellIndex)).toEqual([0, 1, 3]);
  });

  it('never hides shell 0, even if it were the right index', () => {
    expect(stripShells(shells, 0).map((s) => s.shellIndex)).toEqual([0, 1, 3]);
  });

  it('also leaves out shells awaiting their kill after a split close (AC59)', () => {
    expect(stripShells(shells, null, [3]).map((s) => s.shellIndex)).toEqual([0, 1]);
    expect(stripShells(shells, 1, [3]).map((s) => s.shellIndex)).toEqual([0]);
  });

  it('never hides shell 0 through the hidden list either', () => {
    expect(stripShells(shells, null, [0, 1]).map((s) => s.shellIndex)).toEqual([0, 3]);
  });

  it('ignores hidden indices that are not listed', () => {
    expect(stripShells(shells, null, [7]).map((s) => s.shellIndex)).toEqual([0, 1, 3]);
  });
});

describe('hiddenUntilListChanges', () => {
  const before = [{ shellIndex: 0 }, { shellIndex: 2 }];
  const hides = [
    { projectId: 7, shellIndex: 2, list: before },
    { projectId: 9, shellIndex: 1, list: before },
  ];

  it('keeps a killed shell hidden while the alive list is the one seen when its kill settled (AC59)', () => {
    expect(hiddenUntilListChanges(hides, 7, before)).toEqual([2]);
  });

  it('stops hiding it once the alive list has been refreshed, so a reused index shows', () => {
    const after = [{ shellIndex: 0 }, { shellIndex: 2 }];
    expect(hiddenUntilListChanges(hides, 7, after)).toEqual([]);
  });

  it("only hides the given project's shells", () => {
    expect(hiddenUntilListChanges(hides, 8, before)).toEqual([]);
    expect(hiddenUntilListChanges(hides, 9, before)).toEqual([1]);
  });
});
