import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGit, describeGitFailure, type ExecFileFn } from '@main/git/run-git';
import type { ExecFileException } from 'node:child_process';
import { finishOrder, git, initRepo, markerScript, stubGitEnv } from './temp-repo';

const OPTS = { maxBuffer: 1024 * 1024, timeout: 10_000 };

beforeEach(stubGitEnv);
afterEach(() => { vi.unstubAllEnvs(); });

describe('runGit argument and option mapping', () => {
  interface FakeRun { error?: ExecFileException | null; stdout?: string; stderr?: string }

  function fakeExec({ error = null, stdout = '', stderr = '' }: FakeRun = {}) {
    const end = vi.fn();
    const exec = vi.fn<ExecFileFn>((_cmd, _args, _opts, cb) => {
      setTimeout(() => { cb(error, Buffer.from(stdout), Buffer.from(stderr)); }, 0);
      return { stdin: { end } } as unknown as ReturnType<ExecFileFn>;
    });
    return Object.assign(exec, { stdinEnd: end });
  }

  const errorWith = (props: Partial<ExecFileException>): ExecFileException => Object.assign(new Error('Command failed: git x'), props);

  it('prepends core.fsmonitor=false and literal pathspecs before the caller args, and runs git in the repo', async () => {
    const exec = fakeExec({ stdout: 'out' });
    await runGit('/repo', ['status', '--porcelain=v1'], { maxBuffer: 123, timeout: 456 }, exec);
    expect(exec).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = exec.mock.calls[0]!;
    expect(cmd).toBe('git');
    expect(args).toEqual(['-c', 'core.fsmonitor=false', '--literal-pathspecs', 'status', '--porcelain=v1']);
    expect(opts).toMatchObject({ cwd: '/repo', maxBuffer: 123, timeout: 456, encoding: 'buffer' });
    expect(opts.env?.GIT_OPTIONAL_LOCKS).toBe('0');
  });

  it('closes git stdin so a command can never wait on input', async () => {
    const exec = fakeExec();
    await runGit('/repo', ['x'], OPTS, exec);
    expect(exec.stdinEnd).toHaveBeenCalledTimes(1);
  });

  it('returns stdout, stderr and status of a normal run', async () => {
    const r = await runGit('/repo', ['x'], OPTS, fakeExec({ stdout: 'hello', stderr: 'warn' }));
    expect(r).toEqual({ stdout: Buffer.from('hello'), stderr: 'warn', status: 0, tooLarge: false, timedOut: false });
  });

  it('gives the exit code and git stderr of a failing run, with its stdout', async () => {
    const r = await runGit('/repo', ['x'], OPTS, fakeExec({ error: errorWith({ code: 128 }), stdout: 'some', stderr: 'fatal: bad\n' }));
    expect(r).toEqual({ stdout: Buffer.from('some'), stderr: 'fatal: bad\n', status: 128, tooLarge: false, timedOut: false });
  });

  it('gives an empty stderr, not the generic failure message, when a failing git wrote nothing', async () => {
    const r = await runGit('/repo', ['x'], OPTS, fakeExec({ error: errorWith({ code: 1 }) }));
    expect(r).toMatchObject({ stderr: '', status: 1 });
  });

  it('maps an output overflow to tooLarge and drops the partial stdout', async () => {
    const error = errorWith({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', message: 'stdout maxBuffer length exceeded' });
    const r = await runGit('/repo', ['x'], OPTS, fakeExec({ error, stdout: 'partial' }));
    expect(r).toEqual({ stdout: Buffer.alloc(0), stderr: '', status: null, tooLarge: true, timedOut: false });
  });

  it('maps a timeout kill to timedOut and drops the partial stdout', async () => {
    const error = errorWith({ code: null, killed: true, signal: 'SIGTERM' });
    const r = await runGit('/repo', ['x'], OPTS, fakeExec({ error, stdout: 'partial' }));
    expect(r).toEqual({ stdout: Buffer.alloc(0), stderr: '', status: null, tooLarge: false, timedOut: true });
  });

  it('reports a git killed by someone else as a failure with a null status, not as a timeout', async () => {
    const error = errorWith({ code: null, killed: false, signal: 'SIGKILL' });
    const r = await runGit('/repo', ['x'], OPTS, fakeExec({ error, stdout: 'partial' }));
    expect(r).toMatchObject({ status: null, tooLarge: false, timedOut: false });
    expect(r.stderr).toContain('Command failed');
  });

  it('reports any other spawn error through stderr with a null status', async () => {
    const error = errorWith({ code: 'ENOENT', message: 'spawn git ENOENT' });
    const r = await runGit('/repo', ['x'], OPTS, fakeExec({ error }));
    expect(r).toMatchObject({ status: null, tooLarge: false, timedOut: false });
    expect(r.stderr).toContain('ENOENT');
    expect(r.stdout.length).toBe(0);
  });
});

describe('runGit against a real repository', () => {
  it('lets timers run while git is still running (does not block the event loop)', async () => {
    const { root: repo } = initRepo();
    git(repo, 'config', 'alias.slow', '!sleep 0.6');
    expect(await finishOrder(() => runGit(repo, ['slow'], OPTS))).toEqual(['timer', 'work']);
  });

  it('gives the exit status and stderr of a failing command', async () => {
    const { root: repo } = initRepo();
    const r = await runGit(repo, ['cat-file', 'blob', 'HEAD:nope'], OPTS);
    expect(r.status).toBe(128);
    expect(r.stderr).toMatch(/nope|HEAD/);
    expect(r.tooLarge).toBe(false);
  });

  it('maps a real output overflow to tooLarge with no partial stdout', async () => {
    const { root: repo } = initRepo();
    writeFileSync(join(repo, 'big.txt'), 'x'.repeat(200_000));
    git(repo, 'add', 'big.txt');
    const r = await runGit(repo, ['cat-file', 'blob', ':0:big.txt'], { maxBuffer: 10_000, timeout: 10_000 });
    expect(r.tooLarge).toBe(true);
    expect(r.stdout.length).toBe(0);
  });

  it('maps a real timeout to timedOut', async () => {
    const { root: repo } = initRepo();
    git(repo, 'config', 'alias.slow', '!sleep 3');
    const r = await runGit(repo, ['slow'], { maxBuffer: 1024, timeout: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.status).toBeNull();
  });

  it('never runs a repo-local core.fsmonitor program on status (control run proves the marker works)', async () => {
    const { root: repo, base } = initRepo();
    writeFileSync(join(repo, 'a.txt'), 'a');
    const { script, marker } = markerScript(base, 'fsmonitor');
    git(repo, 'config', 'core.fsmonitor', script);
    expect((await runGit(repo, ['status', '--porcelain=v1'], OPTS)).status).toBe(0);
    expect(existsSync(marker)).toBe(false);
    spawnSync('git', ['status', '--porcelain=v1'], { cwd: repo });
    expect(existsSync(marker)).toBe(true);
  });
});

describe('describeGitFailure', () => {
  const base = { stdout: Buffer.alloc(0), stderr: '', status: 1, tooLarge: false, timedOut: false };

  it('uses git stderr when present', () => {
    expect(describeGitFailure({ ...base, stderr: 'fatal: not a git repository\n' }, 'status')).toBe('fatal: not a git repository');
  });

  it('names the timeout, the overflow and a bare exit status', () => {
    expect(describeGitFailure({ ...base, timedOut: true, status: null }, 'status')).toBe('git status timed out');
    expect(describeGitFailure({ ...base, tooLarge: true, status: null }, 'status')).toBe('git status output is too large');
    expect(describeGitFailure({ ...base, status: 2 }, 'diff')).toBe('git diff exited with status 2');
  });
});
