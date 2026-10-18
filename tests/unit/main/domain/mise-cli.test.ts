import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ExecFileException } from 'node:child_process';
import { MISE_LIST_MAX_BUFFER, MISE_LIST_TIMEOUT_MS, listMiseTasks, type MiseExecFn } from '@main/domain/mise-cli';

interface FakeRun { error?: ExecFileException | null; stdout?: string; stderr?: string; never?: boolean }

function fakeExec({ error = null, stdout = '', stderr = '', never = false }: FakeRun = {}) {
  const end = vi.fn();
  const exec = vi.fn<MiseExecFn>((_cmd, _args, _opts, cb) => {
    if (!never) setTimeout(() => { cb(error, stdout, stderr); }, 0);
    return { stdin: { end } } as unknown as ReturnType<MiseExecFn>;
  });
  return Object.assign(exec, { stdinEnd: end });
}

const errorWith = (props: Partial<ExecFileException>): ExecFileException =>
  Object.assign(new Error('Command failed: mise tasks ls --json --local'), props);

afterEach(() => { vi.useRealTimers(); });

describe('listMiseTasks', () => {
  it('runs `mise tasks ls --json --local` in cwd with the given env, a 5 s SIGKILL timeout and a 1 MiB cap', async () => {
    const exec = fakeExec({ stdout: '[]' });
    const env = { PATH: '/opt/bin', MISE_ENV: 'dev' };
    await listMiseTasks('/proj', env, exec);
    expect(exec).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = exec.mock.calls[0]!;
    expect(cmd).toBe('mise');
    expect(args).toEqual(['tasks', 'ls', '--json', '--local']);
    expect(opts).toEqual({ cwd: '/proj', env, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, encoding: 'utf8' });
    expect(MISE_LIST_TIMEOUT_MS).toBe(5000);
    expect(MISE_LIST_MAX_BUFFER).toBe(1024 * 1024);
  });

  it('closes mise stdin so it can never wait on a prompt', async () => {
    const exec = fakeExec({ stdout: '[]' });
    await listMiseTasks('/proj', {}, exec);
    expect(exec.stdinEnd).toHaveBeenCalledTimes(1);
  });

  it('returns stdout of a successful run', async () => {
    expect(await listMiseTasks('/proj', {}, fakeExec({ stdout: '[{"name":"a"}]', stderr: 'mise WARN x' })))
      .toEqual({ kind: 'ok', stdout: '[{"name":"a"}]' });
  });

  it('maps ENOENT to not-found (AC10)', async () => {
    const error = errorWith({ code: 'ENOENT', message: 'spawn mise ENOENT' });
    expect(await listMiseTasks('/proj', {}, fakeExec({ error }))).toEqual({ kind: 'not-found' });
  });

  it('maps a kill at the timeout to timed-out (AC13)', async () => {
    const error = errorWith({ code: null, killed: true, signal: 'SIGKILL' });
    expect(await listMiseTasks('/proj', {}, fakeExec({ error, stdout: '[' }))).toEqual({ kind: 'timed-out' });
  });

  it('maps a non-zero exit to failed with mise stderr', async () => {
    const error = errorWith({ code: 1 });
    expect(await listMiseTasks('/proj', {}, fakeExec({ error, stderr: 'mise ERROR not trusted\n' })))
      .toEqual({ kind: 'failed', stderr: 'mise ERROR not trusted\n' });
  });

  it('maps an output overflow to failed, never to timed-out, even though node killed mise', async () => {
    const error = errorWith({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, message: 'stdout maxBuffer length exceeded' });
    expect(await listMiseTasks('/proj', {}, fakeExec({ error, stdout: '[' }))).toEqual({ kind: 'failed', stderr: 'output is too large' });
  });

  it('maps a mise killed by someone else to failed, not timed-out', async () => {
    const error = errorWith({ code: null, killed: false, signal: 'SIGKILL' });
    const r = await listMiseTasks('/proj', {}, fakeExec({ error }));
    expect(r.kind).toBe('failed');
  });

  it('maps any other spawn error to failed with the error message when stderr is empty', async () => {
    const error = errorWith({ code: 'EACCES', message: 'spawn mise EACCES' });
    expect(await listMiseTasks('/proj', {}, fakeExec({ error }))).toEqual({ kind: 'failed', stderr: 'spawn mise EACCES' });
  });

  it('maps a non-zero exit with no stderr to failed with empty stderr, not the generic node message', async () => {
    const error = errorWith({ code: 2 });
    expect(await listMiseTasks('/proj', {}, fakeExec({ error }))).toEqual({ kind: 'failed', stderr: '' });
  });

  it('resolves timed-out when the child never reports back past the limit, so discovery never waits longer (AC13)', async () => {
    vi.useFakeTimers();
    const p = listMiseTasks('/proj', {}, fakeExec({ never: true }));
    await vi.advanceTimersByTimeAsync(MISE_LIST_TIMEOUT_MS + 1000);
    expect(await Promise.race([p, Promise.resolve('still pending')])).toEqual({ kind: 'timed-out' });
  });

  it('does not resolve timed-out early while mise is still within its limit', async () => {
    vi.useFakeTimers();
    let settled = false;
    void listMiseTasks('/proj', {}, fakeExec({ never: true })).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(MISE_LIST_TIMEOUT_MS);
    expect(settled).toBe(false);
  });

  it('never rejects, even when exec throws synchronously', async () => {
    const exec = vi.fn<MiseExecFn>(() => { throw new TypeError('bad cwd'); });
    await expect(listMiseTasks('/proj', {}, exec)).resolves.toEqual({ kind: 'failed', stderr: 'bad cwd' });
  });

  it('is asynchronous: it returns before mise has reported (AC14)', () => {
    vi.useFakeTimers();
    const exec = fakeExec({ never: true });
    const p = listMiseTasks('/proj', {}, exec);
    expect(p).toBeInstanceOf(Promise);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
