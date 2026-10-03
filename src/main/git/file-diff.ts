/**
 * The unified diff of one changed path, shared by the Git panel (`git:file-diff`) and the Diff tab
 * (`git:diff-sides`). Paths are validated before any git call (AC31, AC43), external diff and textconv
 * programs are disabled (AC32), and output over 1 MiB is reported as too large, never partially (AC20).
 */
import { realpathSync } from 'node:fs';
import { GitCommandError, runGit, type GitRunner } from './run-git';
import { assertWorktreeContained, toRepoRelativePath } from './repo-path';

export const GIT_DIFF_MAX_BYTES = 1024 * 1024;
const GIT_DIFF_TIMEOUT_MS = 15_000;
const DIFF_ARGS = ['diff', '--no-color', '--no-ext-diff', '--no-textconv'] as const;

export interface FileDiffRequest { path: string; origPath?: string; staged?: boolean; untracked?: boolean }
export interface FileDiffResult { diff: string; tooLarge?: true }
export interface FileDiffDeps { run: GitRunner; realpath: (p: string) => string }

export const defaultFileDiffDeps: FileDiffDeps = { run: runGit, realpath: realpathSync };

function diffArgs(req: FileDiffRequest, path: string, origPath: string | undefined): string[] {
  if (req.untracked) return [...DIFF_ARGS, '--no-index', '--', '/dev/null', path];
  if (req.staged) return [...DIFF_ARGS, '--cached', '-M', '--', ...(origPath ? [origPath] : []), path];
  return [...DIFF_ARGS, '--', path];
}

/**
 * Diff `req.path` in the repo at `root`: staged is HEAD vs index (with `origPath` for a rename),
 * unstaged is index vs worktree, untracked is `/dev/null` vs worktree. Throws `PathRejectedError` for a
 * path outside the project before running git, and `GitCommandError` on a timeout or a failed run.
 */
export function readFileDiff(root: string, req: FileDiffRequest, deps: FileDiffDeps = defaultFileDiffDeps): FileDiffResult {
  const path = toRepoRelativePath(root, req.path);
  const origPath = req.origPath === undefined ? undefined : toRepoRelativePath(root, req.origPath);
  if (req.untracked) assertWorktreeContained(root, path, deps.realpath);
  const r = deps.run(root, diffArgs(req, path, origPath), { maxBuffer: GIT_DIFF_MAX_BYTES, timeout: GIT_DIFF_TIMEOUT_MS });
  if (r.tooLarge) return { diff: '', tooLarge: true };
  // `--no-index` exits 1 both when the sides differ (always, against /dev/null) and when it cannot read the file.
  const ok = r.status === 0 || (req.untracked === true && r.status === 1 && r.stdout.length > 0);
  if (!ok) throw new GitCommandError(r, 'diff');
  return { diff: r.stdout.toString('utf8') };
}
