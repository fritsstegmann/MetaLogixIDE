import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGit, describeGitFailure, type SpawnSyncFn } from '@main/git/run-git';
import { git, initRepo, markerScript, stubGitEnv } from './temp-repo';

const OPTS = { maxBuffer: 1024 * 1024, timeout: 10_000 };

beforeEach(stubGitEnv);
afterEach(() => { vi.unstubAllEnvs(); });

describe('runGit argument and option mapping', () => {
  function fakeSpawn(result: Partial<ReturnType<SpawnSyncFn>>) {
    return vi.fn<SpawnSyncFn>(() => ({
      pid: 1, output: [], stdout: Buffer.from(''), stderr: Buffer.from(''), status: 0, signal: null, ...result,
    }));
  }

  it('prepends core.fsmonitor=false and literal pathspecs before the caller args, and runs git in the repo', () => {
    const spawn = fakeSpawn({ stdout: Buffer.from('out') });
    runGit('/repo', ['status', '--porcelain=v1'], { maxBuffer: 123, timeout: 456 }, spawn);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawn.mock.calls[0]!;
    expect(cmd).toBe('git');
    expect(args).toEqual(['-c', 'core.fsmonitor=false', '--literal-pathspecs', 'status', '--porcelain=v1']);
    expect(opts).toMatchObject({ cwd: '/repo', maxBuffer: 123, timeout: 456 });
    expect(opts.env?.GIT_OPTIONAL_LOCKS).toBe('0');
  });

  it('returns stdout, stderr and status of a normal run', () => {
    const spawn = fakeSpawn({ stdout: Buffer.from('hello'), stderr: Buffer.from('warn'), status: 0 });
    const r = runGit('/repo', ['x'], OPTS, spawn);
    expect(r).toEqual({ stdout: Buffer.from('hello'), stderr: 'warn', status: 0, tooLarge: false, timedOut: false });
  });

  it('maps ENOBUFS to tooLarge and drops the partial stdout', () => {
    const error = Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' });
    const r = runGit('/repo', ['x'], OPTS, fakeSpawn({ error, status: null, stdout: Buffer.from('partial') }));
    expect(r.tooLarge).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.stdout.length).toBe(0);
  });

  it('maps ETIMEDOUT to timedOut and drops the partial stdout', () => {
    const error = Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const r = runGit('/repo', ['x'], OPTS, fakeSpawn({ error, status: null, stdout: Buffer.from('partial') }));
    expect(r.timedOut).toBe(true);
    expect(r.tooLarge).toBe(false);
    expect(r.stdout.length).toBe(0);
  });

  it('reports any other spawn error through stderr with a null status', () => {
    const error = Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' });
    const r = runGit('/repo', ['x'], OPTS, fakeSpawn({ error, status: null, stdout: null as unknown as Buffer, stderr: null as unknown as Buffer }));
    expect(r).toMatchObject({ status: null, tooLarge: false, timedOut: false });
    expect(r.stderr).toContain('ENOENT');
    expect(r.stdout.length).toBe(0);
  });
});

describe('runGit against a real repository', () => {
  it('gives the exit status and stderr of a failing command', () => {
    const { root: repo } = initRepo();
    const r = runGit(repo, ['cat-file', 'blob', 'HEAD:nope'], OPTS);
    expect(r.status).toBe(128);
    expect(r.stderr).toMatch(/nope|HEAD/);
    expect(r.tooLarge).toBe(false);
  });

  it('maps a real output overflow to tooLarge with no partial stdout', () => {
    const { root: repo } = initRepo();
    writeFileSync(join(repo, 'big.txt'), 'x'.repeat(200_000));
    git(repo, 'add', 'big.txt');
    const r = runGit(repo, ['cat-file', 'blob', ':0:big.txt'], { maxBuffer: 10_000, timeout: 10_000 });
    expect(r.tooLarge).toBe(true);
    expect(r.stdout.length).toBe(0);
  });

  it('maps a real timeout to timedOut', () => {
    const { root: repo } = initRepo();
    git(repo, 'config', 'alias.slow', '!sleep 3');
    const r = runGit(repo, ['slow'], { maxBuffer: 1024, timeout: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.status).toBeNull();
  });

  it('never runs a repo-local core.fsmonitor program on status (control run proves the marker works)', () => {
    const { root: repo, base } = initRepo();
    writeFileSync(join(repo, 'a.txt'), 'a');
    const { script, marker } = markerScript(base, 'fsmonitor');
    git(repo, 'config', 'core.fsmonitor', script);
    expect(runGit(repo, ['status', '--porcelain=v1'], OPTS).status).toBe(0);
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
