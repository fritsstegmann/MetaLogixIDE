/**
 * Adapter for the user's mise CLI: lists a project's tasks with `mise tasks ls --json --local` without
 * blocking the event loop. The contract is never-reject: every outcome, including a missing binary, a
 * timeout, an output overflow and a synchronous spawn throw, resolves to one `MiseListResult` value so the
 * caller decides what each means. Shaped after `src/main/git/run-git.ts`.
 */
import { execFile, type ChildProcess, type ExecFileException, type ExecFileOptionsWithStringEncoding } from 'node:child_process';

/** mise is killed with SIGKILL after this long (spec AC13). */
export const MISE_LIST_TIMEOUT_MS = 5000;
/** Output cap on either stream; an overflow kills mise and reports `failed` (security S2, S6). */
export const MISE_LIST_MAX_BUFFER = 1024 * 1024;
/** Extra wait past the timeout before giving up on a child whose pipes a grandchild still holds open. */
const WATCHDOG_GRACE_MS = 500;

export type MiseListResult =
  | { kind: 'ok'; stdout: string }
  | { kind: 'not-found' }
  | { kind: 'timed-out' }
  | { kind: 'failed'; stderr: string };

/** Lists mise tasks for `cwd` with exactly `env`; the injection seam that lets tests run without mise. */
export type MiseLister = (cwd: string, env: NodeJS.ProcessEnv) => Promise<MiseListResult>;
export type MiseExecCallback = (error: ExecFileException | null, stdout: string, stderr: string) => void;
export type MiseExecFn = (
  cmd: string, args: readonly string[], opts: ExecFileOptionsWithStringEncoding, cb: MiseExecCallback,
) => Pick<ChildProcess, 'stdin'>;

const LIST_ARGS = ['tasks', 'ls', '--json', '--local'] as const;

const nodeExecFile: MiseExecFn = (cmd, args, opts, cb) => execFile(cmd, args, opts, cb);

function toResult(error: ExecFileException | null, stdout: string, stderr: string): MiseListResult {
  if (!error) return { kind: 'ok', stdout };
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { kind: 'failed', stderr: 'output is too large' };
  if (error.killed === true) return { kind: 'timed-out' };
  if (error.code === 'ENOENT') return { kind: 'not-found' };
  const spawnError = typeof error.code !== 'number' && error.signal == null;
  return { kind: 'failed', stderr: stderr || (spawnError ? error.message : '') };
}

/**
 * Run `mise tasks ls --json --local` in `cwd` with exactly `env` (its PATH is what finds `mise`), stdin
 * closed. Resolves `not-found` on ENOENT, `timed-out` when mise is killed at `MISE_LIST_TIMEOUT_MS` or
 * has not reported shortly after, and `failed` with mise's stderr (or the spawn error) otherwise. Never
 * rejects. `exec` is injectable for tests only.
 */
export function listMiseTasks(cwd: string, env: NodeJS.ProcessEnv, exec: MiseExecFn = nodeExecFile): Promise<MiseListResult> {
  return new Promise((resolve) => {
    const watchdog = setTimeout(() => { resolve({ kind: 'timed-out' }); }, MISE_LIST_TIMEOUT_MS + WATCHDOG_GRACE_MS);
    const settle = (r: MiseListResult): void => { clearTimeout(watchdog); resolve(r); };
    try {
      const child = exec('mise', LIST_ARGS, {
        cwd, env, timeout: MISE_LIST_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: MISE_LIST_MAX_BUFFER, encoding: 'utf8',
      }, (error, stdout, stderr) => { settle(toResult(error, stdout, stderr)); });
      child.stdin?.end();
    } catch (err) {
      settle({ kind: 'failed', stderr: err instanceof Error ? err.message : String(err) });
    }
  });
}
