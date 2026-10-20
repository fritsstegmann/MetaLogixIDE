/**
 * Runs the git commands the user triggers (stage, commit, push, pull, init, clone) without blocking
 * the main process. Unlike `runGit` it adds no safety arguments or environment: these commands should
 * behave exactly as they would in the user's own terminal, hooks and credential helpers included.
 */
import { execFile, type ChildProcess, type ExecFileException, type ExecFileOptionsWithStringEncoding } from 'node:child_process';

export interface GitCommandOptions {
  /** Kill git after this many ms; 0 or absent means no limit. */
  timeout?: number;
  /** Written to git's stdin, which is then closed. */
  input?: string;
}

export interface GitCommandResult { stdout: string; stderr: string; status: number | null; timedOut: boolean }

export type ExecFileTextFn = (
  cmd: string, args: readonly string[], opts: ExecFileOptionsWithStringEncoding,
  cb: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => Pick<ChildProcess, 'stdin'>;

const MAX_BUFFER = 16 * 1024 * 1024;

const nodeExecFile: ExecFileTextFn = (cmd, args, opts, cb) => execFile(cmd, args, opts, cb);

/**
 * Run `git <args>` in `cwd`. Never rejects: a non-zero exit, a timeout or a spawn failure is
 * reported through `status`, `timedOut` and `stderr`. `exec` is injectable for tests only.
 */
export function runGitCommand(cwd: string, args: readonly string[], opts: GitCommandOptions = {}, exec: ExecFileTextFn = nodeExecFile): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    const child = exec('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: opts.timeout ?? 0 }, (error, stdout, stderr) => {
      const timedOut = error?.killed === true;
      const status = error ? (typeof error.code === 'number' ? error.code : null) : 0;
      const spawnError = error && status === null && !timedOut ? error.message : '';
      resolve({ stdout, stderr: stderr || spawnError, status, timedOut });
    });
    child.stdin?.end(opts.input ?? '');
  });
}

/** Git's own words for a failed command, else `fallback`; a timeout is named as one. */
export function gitCommandError(r: GitCommandResult, fallback: string): Error {
  if (r.timedOut) return new Error(`${fallback}: timed out`);
  return new Error(r.stderr.trim() || r.stdout.trim() || fallback);
}
