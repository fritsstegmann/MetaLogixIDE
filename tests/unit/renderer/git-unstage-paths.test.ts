import { describe, it, expect } from 'vitest';
import { unstagePaths } from '@renderer/git-unstage-paths';

describe('unstagePaths', () => {
  it('sends the path of a plain staged entry', () => {
    expect(unstagePaths([{ path: 'a.ts', status: 'M' }])).toEqual(['a.ts']);
  });

  it('sends both the new and the old path of a staged rename, so both sides of the move unstage', () => {
    expect(unstagePaths([{ path: 'new.ts', status: 'R', origPath: 'old.ts' }])).toEqual([
      'new.ts',
      'old.ts',
    ]);
  });

  it('keeps every entry for unstage-all, adding old paths only for renames', () => {
    const staged = [
      { path: 'a.ts', status: 'A' as const },
      { path: 'new.ts', status: 'R' as const, origPath: 'old.ts' },
      { path: 'gone.ts', status: 'D' as const },
    ];
    expect(unstagePaths(staged)).toEqual(['a.ts', 'new.ts', 'old.ts', 'gone.ts']);
  });

  it('gives no paths for no entries', () => {
    expect(unstagePaths([])).toEqual([]);
  });
});
