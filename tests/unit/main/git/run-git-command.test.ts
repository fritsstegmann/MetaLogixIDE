import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { gitCommandError, runGitCommand, type ExecFileTextFn } from '@main/git/run-git-command';
import { initRepo, slowCommandDir, stubGitEnv } from './temp-repo';

describe('runGitCommand', () => {
  beforeEach(stubGitEnv);
  afterEach(() => { vi.unstubAllEnvs(); });

  it('runs git in the given directory and reports a zero status', async () => {
    const { root } = initRepo('rgc-');
    const r = await runGitCommand(root, ['rev-parse', '--show-toplevel']);
    expect(r).toEqual({ stdout: `${root}\n`, stderr: '', status: 0, timedOut: false });
  });

  it('writes input to stdin verbatim', async () => {
    const { root } = initRepo('rgc-');
    const input = 'a `b` $c\nline two\n';
    const r = await runGitCommand(root, ['hash-object', '--stdin'], { input });
    expect(r.stdout).toBe(execFileSync('git', ['hash-object', '--stdin'], { cwd: root, input, encoding: 'utf8' }));
    expect(r.stdout).not.toBe((await runGitCommand(root, ['hash-object', '--stdin'])).stdout);
  });

  it('reports a non-zero exit with git\'s stderr and never rejects', async () => {
    const { root } = initRepo('rgc-');
    const r = await runGitCommand(root, ['rev-parse', 'no-such-ref']);
    expect(r.status).toBe(128);
    expect(r.timedOut).toBe(false);
    expect(r.stderr).toMatch(/unknown revision|ambiguous argument/);
  });

  it('kills git past the timeout and says so', async () => {
    const { base, root } = initRepo('rgc-');
    vi.stubEnv('PATH', `${slowCommandDir(base, 'git', 2)}:${process.env.PATH ?? ''}`);
    const r = await runGitCommand(root, ['status'], { timeout: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.status).toBeNull();
    expect(gitCommandError(r, 'git status failed').message).toBe('git status failed: timed out');
  });

  it('reports a spawn failure through stderr with a null status', async () => {
    const exec: ExecFileTextFn = (_c, _a, _o, cb) => {
      cb(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }), '', '');
      return { stdin: null };
    };
    const r = await runGitCommand('/', ['status'], {}, exec);
    expect(r).toEqual({ stdout: '', stderr: 'spawn git ENOENT', status: null, timedOut: false });
  });
});

describe('gitCommandError', () => {
  const result = { stdout: '', stderr: '', status: 1, timedOut: false };
  it('prefers stderr, then stdout, then the fallback', () => {
    expect(gitCommandError({ ...result, stderr: ' err \n', stdout: 'out' }, 'f').message).toBe('err');
    expect(gitCommandError({ ...result, stdout: ' out \n' }, 'f').message).toBe('out');
    expect(gitCommandError(result, 'f').message).toBe('f');
  });
});
