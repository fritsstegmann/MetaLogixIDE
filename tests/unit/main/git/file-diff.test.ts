import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFileDiff, GIT_DIFF_MAX_BYTES, type FileDiffDeps } from '@main/git/file-diff';
import { runGit, GitCommandError, type GitRunner, type GitRunResult } from '@main/git/run-git';
import { PathRejectedError } from '@main/git/repo-path';
import { commitAll, git, initRepo, makeConflict, markerScript, stubGitEnv } from './temp-repo';

const realDeps = (): FileDiffDeps => ({ run: runGit, realpath: realpathSync });

function okRunner(stdout = 'diff --git a/x b/x\n'): ReturnType<typeof vi.fn<GitRunner>> {
  return vi.fn<GitRunner>(async () => ({ stdout: Buffer.from(stdout), stderr: '', status: 0, tooLarge: false, timedOut: false }));
}

beforeEach(stubGitEnv);
afterEach(() => { vi.unstubAllEnvs(); });

describe('readFileDiff path rules (AC31, AC43)', () => {
  it.each([
    ['../x'], ['/etc/passwd'], ['a/../../x'], [''], ['a\0b'], ['../proj-evil/x'],
  ])('rejects path %j for every kind without running git or touching the disk', async (bad) => {
    for (const flags of [{}, { staged: true }, { untracked: true }]) {
      const run = okRunner();
      const realpath = vi.fn((p: string) => p);
      await expect(readFileDiff('/r/proj', { path: bad, ...flags }, { run, realpath })).rejects.toThrow(PathRejectedError);
      expect(run).not.toHaveBeenCalled();
      expect(realpath).not.toHaveBeenCalled();
    }
  });

  it('rejects a bad origPath without running git', async () => {
    const run = okRunner();
    await expect(readFileDiff('/r/proj', { path: 'ok.ts', origPath: '../../etc/passwd', staged: true }, { run, realpath: (p) => p })).rejects.toThrow(PathRejectedError);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects an untracked path through a symlinked folder that leads outside, without running git', async () => {
    const { root, base } = initRepo();
    mkdirSync(join(base, 'outside'));
    writeFileSync(join(base, 'outside', 'secret.txt'), 'TOP-SECRET');
    mkdirSync(join(root, 'd'));
    symlinkSync(join(base, 'outside'), join(root, 'd', 'up'));
    const run = okRunner();
    await expect(readFileDiff(root, { path: 'd/up/secret.txt', untracked: true }, { run, realpath: realpathSync })).rejects.toThrow(PathRejectedError);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('readFileDiff git arguments (AC19, AC32)', () => {
  const SAFE = ['diff', '--no-color', '--no-ext-diff', '--no-textconv'];

  it('staged rename passes -M and both paths, old first', async () => {
    const run = okRunner();
    await readFileDiff('/r/proj', { path: 'new name é.js', origPath: 'old.ts', staged: true }, { run, realpath: (p) => p });
    expect(run.mock.calls[0]![1]).toEqual([...SAFE, '--cached', '-M', '--', 'old.ts', 'new name é.js']);
    expect(run.mock.calls[0]![2].maxBuffer).toBe(GIT_DIFF_MAX_BYTES);
  });

  it('staged without a rename passes only the path', async () => {
    const run = okRunner();
    await readFileDiff('/r/proj', { path: 'a.ts', staged: true }, { run, realpath: (p) => p });
    expect(run.mock.calls[0]![1]).toEqual([...SAFE, '--cached', '-M', '--', 'a.ts']);
  });

  it('unstaged diffs the path against the index', async () => {
    const run = okRunner();
    await readFileDiff('/r/proj', { path: 'dir/../a.ts' }, { run, realpath: (p) => p });
    expect(run.mock.calls[0]![1]).toEqual([...SAFE, '--', 'a.ts']);
  });

  it('untracked compares /dev/null with the path outside the index', async () => {
    const run = okRunner();
    await readFileDiff('/r/proj', { path: 'u.txt', untracked: true }, { run, realpath: (p) => p });
    expect(run.mock.calls[0]![1]).toEqual([...SAFE, '--no-index', '--', '/dev/null', 'u.txt']);
  });

  it('GIT_DIFF_MAX_BYTES is 1 MiB', async () => {
    expect(GIT_DIFF_MAX_BYTES).toBe(1024 * 1024);
  });
});

describe('readFileDiff failures (AC17, AC20)', () => {
  const fail = (r: Partial<GitRunResult>) => vi.fn<GitRunner>(async () => ({ stdout: Buffer.from('partial'), stderr: '', status: 0, tooLarge: false, timedOut: false, ...r }));

  it('an overflow gives an empty diff flagged tooLarge, never partial output', async () => {
    expect(await readFileDiff('/r/p', { path: 'a' }, { run: fail({ tooLarge: true, status: null }), realpath: (p) => p })).toEqual({ diff: '', tooLarge: true });
  });

  it('a timeout throws', async () => {
    await expect(readFileDiff('/r/p', { path: 'a' }, { run: fail({ timedOut: true, status: null }), realpath: (p) => p })).rejects.toThrow(/timed out/);
  });

  it('a tracked diff with a non-zero exit throws git stderr as a GitCommandError', async () => {
    const run = fail({ status: 128, stderr: 'fatal: bad object\n' });
    await expect(readFileDiff('/r/p', { path: 'a', staged: true }, { run, realpath: (p) => p })).rejects.toThrow(GitCommandError);
    await expect(readFileDiff('/r/p', { path: 'a', staged: true }, { run, realpath: (p) => p })).rejects.toThrow('fatal: bad object');
  });

  it('an untracked diff treats exit 1 as normal and anything above 1 as an error', async () => {
    const one = fail({ status: 1, stdout: Buffer.from('diff text') });
    expect(await readFileDiff('/r/p', { path: 'u', untracked: true }, { run: one, realpath: (p) => p })).toEqual({ diff: 'diff text' });
    const two = fail({ status: 2, stderr: 'error: could not access' });
    await expect(readFileDiff('/r/p', { path: 'u', untracked: true }, { run: two, realpath: (p) => p })).rejects.toThrow('could not access');
  });

  it('an untracked diff of an unreadable file throws instead of returning git error text as the diff', async () => {
    const { root } = initRepo();
    await expect(readFileDiff(root, { path: 'missing.txt', untracked: true }, realDeps())).rejects.toThrow(GitCommandError);
  });

  it('a 1.2 MB untracked file gives { diff: "", tooLarge: true }', async () => {
    const { root } = initRepo();
    writeFileSync(join(root, 'big.txt'), 'line of text\n'.repeat(100_000));
    expect(await readFileDiff(root, { path: 'big.txt', untracked: true }, realDeps())).toEqual({ diff: '', tooLarge: true });
  });
});

describe('readFileDiff against a real repository (AC14, AC18, AC19, AC34)', () => {
  it('staged and unstaged give different comparisons for a staged-then-edited file', async () => {
    const { root } = initRepo();
    writeFileSync(join(root, 'b.ts'), 'one\n');
    commitAll(root);
    writeFileSync(join(root, 'b.ts'), 'two\n');
    git(root, 'add', 'b.ts');
    writeFileSync(join(root, 'b.ts'), 'three\n');
    const staged = (await readFileDiff(root, { path: 'b.ts', staged: true }, realDeps())).diff;
    const unstaged = (await readFileDiff(root, { path: 'b.ts' }, realDeps())).diff;
    expect(staged).toContain('-one');
    expect(staged).toContain('+two');
    expect(unstaged).toContain('-two');
    expect(unstaged).toContain('+three');
  });

  it('untracked gives a full add diff', async () => {
    const { root } = initRepo();
    writeFileSync(join(root, 'u.txt'), 'a\nb\n');
    const { diff } = await readFileDiff(root, { path: 'u.txt', untracked: true }, realDeps());
    expect(diff).toContain('new file mode');
    expect(diff).toContain('+a\n+b');
  });

  it('a staged rename to a name with spaces and non-ASCII gives a rename diff', async () => {
    const { root } = initRepo();
    writeFileSync(join(root, 'old.ts'), 'export const x = 1;\n'.repeat(5));
    commitAll(root);
    git(root, 'mv', 'old.ts', 'new name é.js');
    const { diff } = await readFileDiff(root, { path: 'new name é.js', origPath: 'old.ts', staged: true }, realDeps());
    expect(diff).toContain('rename from old.ts');
  });

  it('a staged deletion shows every line removed', async () => {
    const { root } = initRepo();
    writeFileSync(join(root, 'gone.ts'), 'x\ny\n');
    commitAll(root);
    git(root, 'rm', '-q', 'gone.ts');
    const { diff } = await readFileDiff(root, { path: 'gone.ts', staged: true }, realDeps());
    expect(diff).toContain('deleted file mode');
    expect(diff).toContain('-x\n-y');
  });

  it('a binary change says "Binary files"', async () => {
    const { root } = initRepo();
    writeFileSync(join(root, 'img.bin'), Buffer.from([0, 1, 2, 3]));
    commitAll(root);
    writeFileSync(join(root, 'img.bin'), Buffer.from([0, 9, 9, 9]));
    expect((await readFileDiff(root, { path: 'img.bin' }, realDeps())).diff).toContain('Binary files');
  });

  it('a mode-only change gives old mode / new mode lines', async () => {
    const { root } = initRepo();
    writeFileSync(join(root, 'run.sh'), 'echo hi\n');
    commitAll(root);
    chmodSync(join(root, 'run.sh'), 0o755);
    const { diff } = await readFileDiff(root, { path: 'run.sh' }, realDeps());
    expect(diff).toContain('old mode 100644');
    expect(diff).toContain('new mode 100755');
  });

  it('a UU conflict still returns the diff', async () => {
    const { root } = initRepo();
    makeConflict(root);
    expect((await readFileDiff(root, { path: 'f.ts' }, realDeps())).diff).toContain('<<<<<<<');
  });

  it('treats a file named like a glob literally, not as pathspec magic', async () => {
    const { root } = initRepo();
    writeFileSync(join(root, '*.ts'), 'star\n');
    writeFileSync(join(root, 'a.ts'), 'a\n');
    commitAll(root);
    writeFileSync(join(root, '*.ts'), 'star2\n');
    writeFileSync(join(root, 'a.ts'), 'a2\n');
    const { diff } = await readFileDiff(root, { path: '*.ts' }, realDeps());
    expect(diff).toContain('+star2');
    expect(diff).not.toContain('a/a.ts');
  });

  it('diffs only a file named :(exclude)x, never treating it as an exclude pathspec', async () => {
    const { root } = initRepo();
    writeFileSync(join(root, ':(exclude)x'), 'ex\n');
    writeFileSync(join(root, 'a.ts'), 'a\n');
    commitAll(root);
    writeFileSync(join(root, ':(exclude)x'), 'ex2\n');
    writeFileSync(join(root, 'a.ts'), 'a2\n');
    const { diff } = await readFileDiff(root, { path: ':(exclude)x' }, realDeps());
    expect(diff).toContain('+ex2');
    expect(diff).not.toContain('a/a.ts');
  });

  it('an untracked symlink to an outside file shows the link text, never the target content (AC43)', async () => {
    const { root, base } = initRepo();
    writeFileSync(join(base, 'outside.txt'), 'TOP-SECRET\n');
    symlinkSync('../outside.txt', join(root, 'link'));
    const { diff } = await readFileDiff(root, { path: 'link', untracked: true }, realDeps());
    expect(diff).toContain('+../outside.txt');
    expect(diff).not.toContain('TOP-SECRET');
  });
});

describe('readFileDiff never runs repo-configured programs (AC32)', () => {
  function setup() {
    const { root, base } = initRepo();
    writeFileSync(join(root, 'a.txt'), 'one\n');
    writeFileSync(join(root, '.gitattributes'), 'a.txt diff=conv\n');
    commitAll(root);
    writeFileSync(join(root, 'a.txt'), 'two\n');
    git(root, 'add', 'a.txt');
    writeFileSync(join(root, 'a.txt'), 'three\n');
    writeFileSync(join(root, 'u.txt'), 'new\n');
    return { root, base };
  }

  it('diff.external never runs for staged, unstaged or untracked (control run proves the marker works)', async () => {
    const { root, base } = setup();
    const { script, marker } = markerScript(base, 'external');
    git(root, 'config', 'diff.external', script);
    await readFileDiff(root, { path: 'a.txt', staged: true }, realDeps());
    await readFileDiff(root, { path: 'a.txt' }, realDeps());
    await readFileDiff(root, { path: 'u.txt', untracked: true }, realDeps());
    expect(existsSync(marker)).toBe(false);
    spawnSync('git', ['diff', '--', 'a.txt'], { cwd: root });
    expect(existsSync(marker)).toBe(true);
  });

  it('a textconv driver never runs (control run proves the marker works)', async () => {
    const { root, base } = setup();
    const { script, marker } = markerScript(base, 'textconv');
    git(root, 'config', 'diff.conv.textconv', script);
    await readFileDiff(root, { path: 'a.txt', staged: true }, realDeps());
    await readFileDiff(root, { path: 'a.txt' }, realDeps());
    expect(existsSync(marker)).toBe(false);
    spawnSync('git', ['diff', '--', 'a.txt'], { cwd: root });
    expect(existsSync(marker)).toBe(true);
  });

  it('core.fsmonitor never runs for a worktree diff (control run proves the marker works)', async () => {
    const { root, base } = setup();
    const { script, marker } = markerScript(base, 'fsmonitor');
    git(root, 'config', 'core.fsmonitor', script);
    await readFileDiff(root, { path: 'a.txt' }, realDeps());
    expect(existsSync(marker)).toBe(false);
    spawnSync('git', ['status'], { cwd: root });
    expect(existsSync(marker)).toBe(true);
  });
});
