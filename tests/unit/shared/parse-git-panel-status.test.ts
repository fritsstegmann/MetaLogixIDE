import { describe, it, expect } from 'vitest';
import { parseGitPanelStatus } from '@shared/parse-git-panel-status';

/** Join records the way `git status --porcelain=v1 -z` does: every field NUL-terminated. */
function z(...fields: string[]): string {
  return fields.map((f) => `${f}\0`).join('');
}

describe('parseGitPanelStatus', () => {
  it('reads the branch header with upstream, ahead and behind', () => {
    const out = parseGitPanelStatus(z('## main...origin/main [ahead 3, behind 1]'));
    expect(out).toMatchObject({ branch: 'main', ahead: 3, behind: 1 });
  });

  it('keeps dots and slashes in a branch name with no upstream', () => {
    expect(parseGitPanelStatus(z('## release/1.2.3')).branch).toBe('release/1.2.3');
  });

  it('reads only behind when that is all git reports', () => {
    expect(parseGitPanelStatus(z('## main...origin/main [behind 7]'))).toMatchObject({ ahead: 0, behind: 7 });
  });

  it('reads the branch of a repository with no commits yet', () => {
    expect(parseGitPanelStatus(z('## No commits yet on main')).branch).toBe('main');
  });

  it('gives a null branch on detached HEAD', () => {
    expect(parseGitPanelStatus(z('## HEAD (no branch)')).branch).toBeNull();
  });

  it('gives empty lists and no branch for empty output', () => {
    expect(parseGitPanelStatus('')).toEqual({ branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] });
  });

  it('splits X into staged and Y into unstaged', () => {
    const out = parseGitPanelStatus(z('## main', 'M  a.ts', ' M b.ts', 'MM c.ts', 'A  d.ts', ' D e.ts', 'D  f.ts'));
    expect(out.staged).toEqual([
      { path: 'a.ts', status: 'M' }, { path: 'c.ts', status: 'M' }, { path: 'd.ts', status: 'A' }, { path: 'f.ts', status: 'D' },
    ]);
    expect(out.unstaged).toEqual([
      { path: 'b.ts', status: 'M' }, { path: 'c.ts', status: 'M' }, { path: 'e.ts', status: 'D' },
    ]);
  });

  it('reads a rename record as NEW then ORIG, unquoted, with spaces and non-ASCII', () => {
    const out = parseGitPanelStatus(z('## main', 'R  new name é.js', 'old.ts', ' M after.ts'));
    expect(out.staged).toEqual([{ path: 'new name é.js', status: 'R', origPath: 'old.ts' }]);
    expect(out.unstaged).toEqual([{ path: 'after.ts', status: 'M' }]);
  });

  it('keeps the unstaged half of a renamed-then-edited file without an origPath', () => {
    const out = parseGitPanelStatus(z('RM new.ts', 'old.ts'));
    expect(out.staged).toEqual([{ path: 'new.ts', status: 'R', origPath: 'old.ts' }]);
    expect(out.unstaged).toEqual([{ path: 'new.ts', status: 'M' }]);
  });

  it('reads a copy record with its origPath, shown as a rename', () => {
    const out = parseGitPanelStatus(z('C  copy.ts', 'src.ts', 'M  next.ts'));
    expect(out.staged).toEqual([{ path: 'copy.ts', status: 'R', origPath: 'src.ts' }, { path: 'next.ts', status: 'M' }]);
  });

  it('puts a UU conflict in both staged and unstaged', () => {
    const out = parseGitPanelStatus(z('UU conflict.ts'));
    expect(out.staged).toEqual([{ path: 'conflict.ts', status: 'U' }]);
    expect(out.unstaged).toEqual([{ path: 'conflict.ts', status: 'U' }]);
  });

  it('lists ?? entries as untracked only, each file individually', () => {
    const out = parseGitPanelStatus(z('?? dir/sub/u1.txt', '?? dir/u2.txt', '?? sp ace.txt'));
    expect(out.untracked).toEqual(['dir/sub/u1.txt', 'dir/u2.txt', 'sp ace.txt']);
    expect(out.staged).toEqual([]);
    expect(out.unstaged).toEqual([]);
  });

  it('skips ignored entries', () => {
    const out = parseGitPanelStatus(z('!! build/out.js'));
    expect(out).toMatchObject({ staged: [], unstaged: [], untracked: [] });
  });

  it('maps an unknown status letter to M', () => {
    const out = parseGitPanelStatus(z('T  typechange', ' T t2'));
    expect(out.staged).toEqual([{ path: 'typechange', status: 'M' }]);
    expect(out.unstaged).toEqual([{ path: 't2', status: 'M' }]);
  });

  it('keeps a path that contains a newline or an arrow intact', () => {
    const out = parseGitPanelStatus(z(' M line\nbreak.txt', ' M a -> b.txt'));
    expect(out.unstaged.map((e) => e.path)).toEqual(['line\nbreak.txt', 'a -> b.txt']);
  });

  it('ignores a malformed short record', () => {
    expect(parseGitPanelStatus(z('MM', 'M', ' M ok.ts')).unstaged).toEqual([{ path: 'ok.ts', status: 'M' }]);
  });
});
