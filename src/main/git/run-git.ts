/**
 * The single git runner for the Diff tab and the Git panel's status and diff reads (spec AC32, AC43).
 * Every call disables a repo-local `core.fsmonitor` program and pathspec magic, and sets
 * `GIT_OPTIONAL_LOCKS=0` so status takes no optional index lock and polling never contends with the
 * user's own git; spawn failures map to plain values so callers decide what an overflow or a timeout means.
 */
import { execFile, type ChildProcess, type ExecFileException, type ExecFileOptionsWithBufferEncoding } from 'node:child_process';

export interface GitRunOptions { maxBuffer: number; timeout: number }

/** `stdout` is empty whenever `tooLarge` or `timedOut` is set: partial output is never returned. */
export interface GitRunResult { stdout: Buffer; stderr: string; status: number | null; tooLarge: boolean; timedOut: boolean }

export type GitRunner = (repoPath: string, args: readonly string[], opts: GitRunOptions) => Promise<GitRunResult>;
export type ExecFileCallback = (error: ExecFileException | null, stdout: Buffer, stderr: Buffer) => void;
export type ExecFileFn = (cmd: string, args: readonly string[], opts: ExecFileOptionsWithBufferEncoding, cb: ExecFileCallback) => Pick<ChildProcess, 'stdin'>;

const SAFETY_ARGS = ['-c', 'core.fsmonitor=false', '--literal-pathspecs'] as const;

const nodeExecFile: ExecFileFn = (cmd, args, opts, cb) => execFile(cmd, args, opts, cb);

function toResult(error: ExecFileException | null, stdout: Buffer, stderr: Buffer): GitRunResult {
  const tooLarge = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  const timedOut = !tooLarge && error?.killed === true;
  const truncated = tooLarge || timedOut;
  const exitCode = typeof error?.code === 'number' ? error.code : null;
  const status = error ? exitCode : 0;
  const text = stderr.toString('utf8') || (error && !truncated && exitCode === null ? error.message : '');
  return { stdout: truncated ? Buffer.alloc(0) : stdout, stderr: text, status, tooLarge, timedOut };
}

/**
 * Run `git <safety args> <args>` in `repoPath` without blocking the event loop. Output over
 * `maxBuffer` on either stream becomes `tooLarge` and a run past `timeout` becomes `timedOut` (git
 * is killed in both cases); any other spawn error is reported through `stderr` with a null status.
 * Never rejects. `exec` is injectable for tests only.
 */
export function runGit(repoPath: string, args: readonly string[], opts: GitRunOptions, exec: ExecFileFn = nodeExecFile): Promise<GitRunResult> {
  return new Promise((resolve) => {
    const child = exec('git', [...SAFETY_ARGS, ...args], {
      cwd: repoPath,
      encoding: 'buffer',
      maxBuffer: opts.maxBuffer,
      timeout: opts.timeout,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }, (error, stdout, stderr) => { resolve(toResult(error, stdout, stderr)); });
    child.stdin?.end();
  });
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
