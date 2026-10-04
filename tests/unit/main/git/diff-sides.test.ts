import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDiffSides, HIGHLIGHT_MAX_BYTES, nodeWorktreeFs, type DiffSidesDeps, type DiffSidesRequest } from '@main/git/diff-sides';
import { runGit, type GitRunner, type GitRunResult } from '@main/git/run-git';
import { PathRejectedError } from '@main/git/repo-path';
import { commitAll, git, initRepo, makeConflict, markerScript, stubGitEnv } from './temp-repo';

/** Real deps where every collaborator is a spy, so a test can assert what was (not) called. */
function spyDeps() {
  const deps = {
    run: vi.fn<GitRunner>(runGit),
    realpath: vi.fn((p: string) => realpathSync(p)),
    fs: {
      lstat: vi.fn(nodeWorktreeFs.lstat),
      readlink: vi.fn(nodeWorktreeFs.readlink),
      readFile: vi.fn(nodeWorktreeFs.readFile),
    },
  } satisfies DiffSidesDeps;
  return deps;
}

function expectNoContentRead(deps: ReturnType<typeof spyDeps>): void {
  expect(deps.fs.lstat).not.toHaveBeenCalled();
  expect(deps.fs.readlink).not.toHaveBeenCalled();
  expect(deps.fs.readFile).not.toHaveBeenCalled();
  expect(deps.run.mock.calls.filter((c) => c[1][0] !== 'diff')).toEqual([]);
}

function ok(root: string, req: DiffSidesRequest, deps: DiffSidesDeps = spyDeps()) {
  const r = readDiffSides(root, req, deps);
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
  return r;
}

beforeEach(stubGitEnv);
afterEach(() => { vi.unstubAllEnvs(); });

describe('readDiffSides path rules (AC31, AC43)', () => {
  it.each(['../x', '/etc/passwd', 'a/../../x', '', 'a\0b', '../proj-evil/x'])('rejects path %j for every kind with no git call and no fs access', (bad) => {
    for (const kind of ['staged', 'unstaged', 'untracked'] as const) {
      const deps = spyDeps();
      expect(() => readDiffSides('/r/proj', { kind, path: bad }, deps)).toThrow(PathRejectedError);
      expect(deps.run).not.toHaveBeenCalled();
      expect(deps.realpath).not.toHaveBeenCalled();
      expectNoContentRead(deps);
    }
  });

  it('rejects a bad origPath with no git call', () => {
    const deps = spyDeps();
    expect(() => readDiffSides('/r/proj', { kind: 'staged', path: 'ok.ts', origPath: '../../etc/passwd' }, deps)).toThrow(PathRejectedError);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it.each(['unstaged', 'untracked'] as const)('rejects a %s path through a symlinked folder that leads outside, with no git call', (kind) => {
    const { root, base } = initRepo();
    mkdirSync(join(base, 'outside'));
    writeFileSync(join(base, 'outside', 'secret.txt'), 'TOP-SECRET');
    mkdirSync(join(root, 'd'));
    symlinkSync(join(base, 'outside'), join(root, 'd', 'up'));
    const deps = spyDeps();
    expect(() => readDiffSides(root, { kind, path: 'd/up/secret.txt' }, deps)).toThrow(PathRejectedError);
    expect(deps.run).not.toHaveBeenCalled();
    expectNoContentRead(deps);
  });
});

describe('readDiffSides caps and skips (AC20, AC30, AC41, AC42)', () => {
  it('a 1.2 MB untracked file gives too-large and reads no content', () => {
    const { root } = initRepo();
    writeFileSync(join(root, 'big.txt'), 'line of text\n'.repeat(100_000));
    const deps = spyDeps();
    expect(readDiffSides(root, { kind: 'untracked', path: 'big.txt' }, deps)).toEqual({ status: 'too-large' });
    expect(deps.run).toHaveBeenCalledTimes(1);
    expectNoContentRead(deps);
  });

  it('returns sha1(diff) and then unchanged for the same hash, reading no content the second time', () => {
    const { root } = initRepo();
    writeFileSync(join(root, 'a.ts'), 'one\n');
    commitAll(root);
    writeFileSync(join(root, 'a.ts'), 'two\n');
    const first = ok(root, { kind: 'unstaged', path: 'a.ts' });
    expect(first.diffHash).toBe(createHash('sha1').update(first.diff).digest('hex'));
    const deps = spyDeps();
    expect(readDiffSides(root, { kind: 'unstaged', path: 'a.ts', ifDiffHashNot: first.diffHash }, deps)).toEqual({ status: 'unchanged' });
    expect(deps.run).toHaveBeenCalledTimes(1);
    expectNoContentRead(deps);
  });

  it('a different hash still returns ok with content', () => {
    const { root } = initRepo();
    writeFileSync(join(root, 'a.ts'), 'one\n');
    commitAll(root);
    writeFileSync(join(root, 'a.ts'), 'two\n');
    expect(ok(root, { kind: 'unstaged', path: 'a.ts', ifDiffHashNot: 'deadbeef' }).newSide).toEqual({ text: 'two\n' });
  });

  it('HIGHLIGHT_MAX_BYTES is 256 KiB', () => {
    expect(HIGHLIGHT_MAX_BYTES).toBe(256 * 1024);
  });

  it('a 300 KiB file, between 256 KiB and the old 512 KiB limit, gives too-large', () => {
    const { root } = initRepo();
    const body = 'const value = 1;\n'.repeat(Math.ceil((300 * 1024) / 17));
    writeFileSync(join(root, 'big.ts'), body);
    commitAll(root);
    writeFileSync(join(root, 'big.ts'), `// edit\n${body}`);
    const r = ok(root, { kind: 'unstaged', path: 'big.ts' });
    expect(r.diff).toContain('+// edit');
    expect(r.oldSide).toEqual({ text: null, skipped: 'too-large' });
    expect(r.newSide).toEqual({ text: null, skipped: 'too-large' });
  });

  it('a 600 KiB file gives too-large on both sides while the diff is still returned', () => {
    const { root } = initRepo();
    const body = 'const value = 1;\n'.repeat(Math.ceil((600 * 1024) / 17));
    writeFileSync(join(root, 'mid.ts'), body);
    commitAll(root);
    writeFileSync(join(root, 'mid.ts'), `// edit\n${body}`);
    git(root, 'add', 'mid.ts');
    const staged = ok(root, { kind: 'staged', path: 'mid.ts' });
    expect(staged.diff).toContain('+// edit');
    expect(staged.oldSide).toEqual({ text: null, skipped: 'too-large' });
    expect(staged.newSide).toEqual({ text: null, skipped: 'too-large' });
    writeFileSync(join(root, 'mid.ts'), `// edit 2\n${body}`);
    const deps = spyDeps();
    const unstaged = ok(root, { kind: 'unstaged', path: 'mid.ts' }, deps);
    expect(deps.fs.readFile).not.toHaveBeenCalled();
    expect(unstaged.oldSide).toEqual({ text: null, skipped: 'too-large' });
    expect(unstaged.newSide).toEqual({ text: null, skipped: 'too-large' });
  });

  it('a side of exactly HIGHLIGHT_MAX_BYTES is read, and one byte more is too large, for git and worktree reads', () => {
    const { root } = initRepo();
    const exact = `${'x'.repeat(63)}\n`.repeat(HIGHLIGHT_MAX_BYTES / 64);
    expect(Buffer.byteLength(exact)).toBe(HIGHLIGHT_MAX_BYTES);
    writeFileSync(join(root, 'edge.txt'), exact);
    commitAll(root);
    writeFileSync(join(root, 'edge.txt'), `b${exact}`);
    const r = ok(root, { kind: 'unstaged', path: 'edge.txt' });
    expect(r.oldSide.text).toBe(exact);
    expect(r.newSide).toEqual({ text: null, skipped: 'too-large' });
    git(root, 'add', 'edge.txt');
    writeFileSync(join(root, 'edge.txt'), exact);
    const back = ok(root, { kind: 'unstaged', path: 'edge.txt' });
    expect(back.oldSide).toEqual({ text: null, skipped: 'too-large' });
    expect(back.newSide.text).toBe(exact);
  });
});

describe('readDiffSides versions per kind (AC14, AC18, AC19, AC34)', () => {
  function stagedThenEdited() {
    const { root, base } = initRepo();
    writeFileSync(join(root, 'b.ts'), 'head\n');
    commitAll(root);
    writeFileSync(join(root, 'b.ts'), 'index\n');
    git(root, 'add', 'b.ts');
    writeFileSync(join(root, 'b.ts'), 'worktree\n');
    return { root, base };
  }

  it('staged gives HEAD vs index content', () => {
    const { root } = stagedThenEdited();
    const r = ok(root, { kind: 'staged', path: 'b.ts' });
    expect(r.oldSide).toEqual({ text: 'head\n' });
    expect(r.newSide).toEqual({ text: 'index\n' });
    expect(r.diff).toContain('+index');
  });

  it('unstaged gives index vs worktree content', () => {
    const { root } = stagedThenEdited();
    const r = ok(root, { kind: 'unstaged', path: 'b.ts' });
    expect(r.oldSide).toEqual({ text: 'index\n' });
    expect(r.newSide).toEqual({ text: 'worktree\n' });
  });

  it('untracked gives an absent old side and the worktree new side', () => {
    const { root } = initRepo();
    writeFileSync(join(root, 'u.txt'), 'new file\n');
    const r = ok(root, { kind: 'untracked', path: 'u.txt' });
    expect(r.oldSide).toEqual({ text: null, skipped: 'absent' });
    expect(r.newSide).toEqual({ text: 'new file\n' });
  });

  it('a staged added file has an absent old side and the index new side', () => {
    const { root } = initRepo();
    writeFileSync(join(root, 'seed.txt'), 's\n');
    commitAll(root);
    writeFileSync(join(root, 'added.ts'), 'added\n');
    git(root, 'add', 'added.ts');
    const r = ok(root, { kind: 'staged', path: 'added.ts' });
    expect(r.oldSide).toEqual({ text: null, skipped: 'absent' });
    expect(r.newSide).toEqual({ text: 'added\n' });
  });

  it('a staged added file in a repo with no commits yet has an absent old side', () => {
    const { root } = initRepo();
    writeFileSync(join(root, 'first.ts'), 'first\n');
    git(root, 'add', 'first.ts');
    const r = ok(root, { kind: 'staged', path: 'first.ts' });
    expect(r.oldSide).toEqual({ text: null, skipped: 'absent' });
    expect(r.newSide).toEqual({ text: 'first\n' });
  });

  it('a staged deletion has the HEAD old side and an absent new side', () => {
    const { root } = initRepo();
    writeFileSync(join(root, 'gone.ts'), 'bye\n');
    commitAll(root);
    git(root, 'rm', '-q', 'gone.ts');
    const r = ok(root, { kind: 'staged', path: 'gone.ts' });
    expect(r.oldSide).toEqual({ text: 'bye\n' });
    expect(r.newSide).toEqual({ text: null, skipped: 'absent' });
  });

  it('an unstaged deletion, folder and all, has the index old side and an absent new side', () => {
    const { root } = initRepo();
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, 'dir', 'gone.ts'), 'bye\n');
    commitAll(root);
    execFileSync('rm', ['-r', join(root, 'dir')]);
    const r = ok(root, { kind: 'unstaged', path: 'dir/gone.ts' });
    expect(r.oldSide).toEqual({ text: 'bye\n' });
    expect(r.newSide).toEqual({ text: null, skipped: 'absent' });
  });

  it('a rename reads the old side from HEAD:<origPath> and the diff says rename from', () => {
    const { root } = initRepo();
    writeFileSync(join(root, 'old.ts'), 'export const x = 1;\n'.repeat(5));
    commitAll(root);
    git(root, 'mv', 'old.ts', 'new name é.js');
    writeFileSync(join(root, 'new name é.js'), 'export const x = 1;\n'.repeat(5) + 'export const y = 2;\n');
    git(root, 'add', 'new name é.js');
    const r = ok(root, { kind: 'staged', path: 'new name é.js', origPath: 'old.ts' });
    expect(r.diff).toContain('rename from old.ts');
    expect(r.oldSide).toEqual({ text: 'export const x = 1;\n'.repeat(5) });
    expect(r.newSide.text).toContain('export const y = 2;');
  });

  it('a binary change says Binary files and skips both sides as binary', () => {
    const { root } = initRepo();
    writeFileSync(join(root, 'img.bin'), Buffer.from([0x89, 0, 1, 2]));
    commitAll(root);
    writeFileSync(join(root, 'img.bin'), Buffer.from([0x89, 0, 9, 9]));
    const r = ok(root, { kind: 'unstaged', path: 'img.bin' });
    expect(r.diff).toContain('Binary files');
    expect(r.oldSide).toEqual({ text: null, skipped: 'binary' });
    expect(r.newSide).toEqual({ text: null, skipped: 'binary' });
  });

  it('a mode-only change gives old mode lines and both sides as text', () => {
    const { root } = initRepo();
    writeFileSync(join(root, 'run.sh'), 'echo hi\n');
    commitAll(root);
    chmodSync(join(root, 'run.sh'), 0o755);
    const r = ok(root, { kind: 'unstaged', path: 'run.sh' });
    expect(r.diff).toContain('old mode 100644');
    expect(r.oldSide).toEqual({ text: 'echo hi\n' });
    expect(r.newSide).toEqual({ text: 'echo hi\n' });
  });

  function conflicted() {
    const { root } = initRepo();
    makeConflict(root);
    return root;
  }

  it('a UU conflict gives the index side unavailable and still returns the diff (unstaged)', () => {
    const root = conflicted();
    const r = ok(root, { kind: 'unstaged', path: 'f.ts' });
    expect(r.diff).toContain('<<<<<<<');
    expect(r.oldSide).toEqual({ text: null, skipped: 'unavailable' });
    expect(r.newSide.text).toContain('<<<<<<<');
  });

  it('a UU conflict gives the index side unavailable on the staged entry too', () => {
    const root = conflicted();
    const r = ok(root, { kind: 'staged', path: 'f.ts' });
    expect(r.oldSide).toEqual({ text: 'theirs\n' });
    expect(r.newSide).toEqual({ text: null, skipped: 'unavailable' });
  });
});

describe('readDiffSides working-tree reads (AC43)', () => {
  it('an untracked symlink to an outside file gives the link text, and the outside content appears nowhere', () => {
    const { root, base } = initRepo();
    writeFileSync(join(base, 'outside.txt'), 'TOP-SECRET\n');
    symlinkSync('../outside.txt', join(root, 'link'));
    const deps = spyDeps();
    const r = ok(root, { kind: 'untracked', path: 'link' }, deps);
    expect(r.newSide).toEqual({ text: '../outside.txt' });
    expect(JSON.stringify(r)).not.toContain('TOP-SECRET');
    expect(deps.fs.readFile).not.toHaveBeenCalled();
  });

  it('the default readFile refuses to follow a symlink', () => {
    const { root, base } = initRepo();
    writeFileSync(join(base, 'outside.txt'), 'TOP-SECRET\n');
    symlinkSync(join(base, 'outside.txt'), join(root, 'link'));
    expect(() => nodeWorktreeFs.readFile(join(root, 'link'), 100)).toThrow();
  });

  it('the default readFile reads at most limit + 1 bytes', () => {
    const { root } = initRepo();
    writeFileSync(join(root, 'f.txt'), 'abcdefghij');
    expect(nodeWorktreeFs.readFile(join(root, 'f.txt'), 3).toString()).toBe('abcd');
    expect(nodeWorktreeFs.readFile(join(root, 'f.txt'), 100).toString()).toBe('abcdefghij');
  });

  it('an unreadable worktree file gives unavailable while the diff is still returned', () => {
    const { root } = initRepo();
    writeFileSync(join(root, 'a.ts'), 'one\n');
    commitAll(root);
    writeFileSync(join(root, 'a.ts'), 'two\n');
    const deps = spyDeps();
    deps.fs.readFile.mockImplementation(() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });
    const r = ok(root, { kind: 'unstaged', path: 'a.ts' }, deps);
    expect(r.diff).toContain('+two');
    expect(r.newSide).toEqual({ text: null, skipped: 'unavailable' });
    expect(r.oldSide).toEqual({ text: 'one\n' });
  });

  it('a worktree read that comes back larger than the cap gives too-large', () => {
    const { root } = initRepo();
    writeFileSync(join(root, 'a.ts'), 'one\n');
    commitAll(root);
    writeFileSync(join(root, 'a.ts'), 'two\n');
    const deps = spyDeps();
    deps.fs.readFile.mockImplementation(() => Buffer.alloc(HIGHLIGHT_MAX_BYTES + 1, 0x61));
    expect(ok(root, { kind: 'unstaged', path: 'a.ts' }, deps).newSide).toEqual({ text: null, skipped: 'too-large' });
  });

  it('a worktree path that is not a regular file or symlink gives unavailable without reading it', () => {
    const { root } = initRepo();
    writeFileSync(join(root, 'a.ts'), 'one\n');
    commitAll(root);
    writeFileSync(join(root, 'a.ts'), 'two\n');
    const deps = spyDeps();
    deps.fs.lstat.mockImplementation(() => ({ isSymbolicLink: () => false, isFile: () => false, size: 0 }));
    expect(ok(root, { kind: 'unstaged', path: 'a.ts' }, deps).newSide).toEqual({ text: null, skipped: 'unavailable' });
    expect(deps.fs.readFile).not.toHaveBeenCalled();
  });

  it('an lstat failure other than a missing file gives unavailable', () => {
    const { root } = initRepo();
    writeFileSync(join(root, 'a.ts'), 'one\n');
    commitAll(root);
    writeFileSync(join(root, 'a.ts'), 'two\n');
    const deps = spyDeps();
    deps.fs.lstat.mockImplementation(() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });
    expect(ok(root, { kind: 'unstaged', path: 'a.ts' }, deps).newSide).toEqual({ text: null, skipped: 'unavailable' });
  });
});

describe('readDiffSides git content-read failures degrade, never fail the diff', () => {
  const DIFF: GitRunResult = { stdout: Buffer.from('diff --git a/a b/a\n'), stderr: '', status: 0, tooLarge: false, timedOut: false };

  function runner(byCommand: Record<string, Partial<GitRunResult>>): GitRunner {
    return vi.fn<GitRunner>((_root, args) => ({ ...DIFF, ...(byCommand[args[0]!] ?? {}) }));
  }

  const fs = { lstat: vi.fn(), readlink: vi.fn(), readFile: vi.fn() };

  it('a timed-out blob read gives unavailable', () => {
    const run = runner({ 'cat-file': { stdout: Buffer.alloc(0), status: null, timedOut: true } });
    const r = readDiffSides('/r/p', { kind: 'staged', path: 'a' }, { run, realpath: (p) => p, fs });
    expect(r).toMatchObject({ status: 'ok', oldSide: { text: null, skipped: 'unavailable' }, newSide: { text: null, skipped: 'unavailable' } });
  });

  it('a missing index entry whose ls-files check fails gives unavailable', () => {
    const run = runner({ 'cat-file': { status: 128, stdout: Buffer.alloc(0) }, 'ls-files': { status: 128, stdout: Buffer.alloc(0) } });
    const r = readDiffSides('/r/p', { kind: 'staged', path: 'a' }, { run, realpath: (p) => p, fs });
    expect(r).toMatchObject({ status: 'ok', oldSide: { skipped: 'absent' }, newSide: { skipped: 'unavailable' } });
  });

  it('reads blobs as <rev>:<path> and :0:<path>, with the 512 KiB + 1 buffer', () => {
    const run = runner({});
    readDiffSides('/r/p', { kind: 'staged', path: 'n.ts', origPath: 'o.ts' }, { run, realpath: (p) => p, fs });
    const calls = (run as ReturnType<typeof vi.fn<GitRunner>>).mock.calls.filter((c) => c[1][0] === 'cat-file');
    expect(calls.map((c) => c[1])).toEqual([['cat-file', 'blob', 'HEAD:o.ts'], ['cat-file', 'blob', ':0:n.ts']]);
    expect(calls[0]![2].maxBuffer).toBe(HIGHLIGHT_MAX_BYTES + 1);
  });
});

describe('readDiffSides never runs repo-configured programs (AC32, AC43)', () => {
  function setup() {
    const { root, base } = initRepo();
    writeFileSync(join(root, 'a.txt'), 'one\n');
    writeFileSync(join(root, '.gitattributes'), '*.txt diff=conv\n');
    commitAll(root);
    writeFileSync(join(root, 'a.txt'), 'two\n');
    git(root, 'add', 'a.txt');
    writeFileSync(join(root, 'a.txt'), 'three\n');
    writeFileSync(join(root, 'u.txt'), 'new\n');
    return { root, base };
  }

  function readAllKinds(root: string): void {
    ok(root, { kind: 'staged', path: 'a.txt' });
    ok(root, { kind: 'unstaged', path: 'a.txt' });
    ok(root, { kind: 'untracked', path: 'u.txt' });
  }

  it.each([
    ['core.fsmonitor', ['status']],
    ['diff.external', ['diff', '--', 'a.txt']],
    ['diff.conv.textconv', ['diff', '--', 'a.txt']],
  ])('%s never runs (control run proves the marker works)', (key, control) => {
    const { root, base } = setup();
    const { script, marker } = markerScript(base, key);
    git(root, 'config', key, script);
    readAllKinds(root);
    expect(existsSync(marker)).toBe(false);
    spawnSync('git', control, { cwd: root });
    expect(existsSync(marker)).toBe(true);
  });
});
