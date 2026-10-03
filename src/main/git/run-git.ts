/**
 * The single git runner for the Diff tab and the Git panel's status and diff reads (spec AC32, AC43).
 * Every call disables a repo-local `core.fsmonitor` program and pathspec magic, and sets
 * `GIT_OPTIONAL_LOCKS=0` so status takes no optional index lock and polling never contends with the
 * user's own git; spawn failures map to plain values so callers decide what an overflow or a timeout means.
 */
import { spawnSync, type SpawnSyncOptionsWithBufferEncoding, type SpawnSyncReturns } from 'node:child_process';

export interface GitRunOptions { maxBuffer: number; timeout: number }

/** `stdout` is empty whenever `tooLarge` or `timedOut` is set: partial output is never returned. */
export interface GitRunResult { stdout: Buffer; stderr: string; status: number | null; tooLarge: boolean; timedOut: boolean }

export type GitRunner = (repoPath: string, args: readonly string[], opts: GitRunOptions) => GitRunResult;
export type SpawnSyncFn = (cmd: string, args: readonly string[], opts: SpawnSyncOptionsWithBufferEncoding) => SpawnSyncReturns<Buffer>;

const SAFETY_ARGS = ['-c', 'core.fsmonitor=false', '--literal-pathspecs'] as const;

/**
 * Run `git <safety args> <args>` synchronously in `repoPath`. ENOBUFS becomes `tooLarge`, ETIMEDOUT
 * becomes `timedOut`, and any other spawn error is reported through `stderr` with a null status.
 * `spawn` is injectable for tests only.
 */
export function runGit(repoPath: string, args: readonly string[], opts: GitRunOptions, spawn: SpawnSyncFn = spawnSync): GitRunResult {
  const r = spawn('git', [...SAFETY_ARGS, ...args], {
    cwd: repoPath,
    maxBuffer: opts.maxBuffer,
    timeout: opts.timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  const tooLarge = code === 'ENOBUFS';
  const timedOut = code === 'ETIMEDOUT';
  const truncated = tooLarge || timedOut;
  const stderr = r.stderr?.toString('utf8') || (r.error && !truncated ? r.error.message : '');
  return { stdout: truncated ? Buffer.alloc(0) : (r.stdout ?? Buffer.alloc(0)), stderr, status: r.status, tooLarge, timedOut };
}

/** A user-facing message for a failed run: git's stderr when it wrote one, else what went wrong with `git <command>`. */
export function describeGitFailure(r: GitRunResult, command: string): string {
  if (r.tooLarge) return `git ${command} output is too large`;
  if (r.timedOut) return `git ${command} timed out`;
  return r.stderr.trim() || `git ${command} exited with status ${String(r.status)}`;
}

/** A git command that failed; `message` is `describeGitFailure`'s text, and the run result is kept for logging. */
export class GitCommandError extends Error {
  constructor(readonly result: GitRunResult, command: string) {
    super(describeGitFailure(result, command));
    this.name = 'GitCommandError';
  }
}
