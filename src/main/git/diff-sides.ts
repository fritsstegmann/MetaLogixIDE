/**
 * Side-by-side data for one Diff tab entry (`git:diff-sides`): the unified diff plus each side's full
 * content, read only for syntax highlighting (spec AC14, AC34, AC38, AC41–AC43). Object versions come
 * from `git cat-file blob`, which runs no textconv or filter; working-tree reads never follow a symlink.
 * A content read that fails only removes highlighting for that side, with a typed `skipped` reason.
 */
import { closeSync, constants, lstatSync, openSync, readlinkSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import log from 'electron-log/main';
import type { GitDiffKind, GitSideContent, IpcResponse } from '@shared/ipc-contract';
import { readFileDiff, type FileDiffDeps } from './file-diff';
import { assertWorktreeContained, toRepoRelativePath } from './repo-path';
import { runGit, type GitRunner } from './run-git';

/** Per-side highlight limit. 512 KiB cost ~300 ms of extra click-to-highlight time in the e2e measurement, so the plan's 256 KiB fallback applies. */
export const HIGHLIGHT_MAX_BYTES = 256 * 1024;
const CONTENT_TIMEOUT_MS = 15_000;
const BINARY_SCAN_BYTES = 8192;

export interface DiffSidesRequest { kind: GitDiffKind; path: string; origPath?: string; ifDiffHashNot?: string }
export type DiffSidesResponse = IpcResponse<'git:diff-sides'>;
export interface WorktreeStat { isSymbolicLink(): boolean; isFile(): boolean; size: number }

/** Working-tree access; `readFile` must refuse a symlink and return at most `limit + 1` bytes. */
export interface WorktreeFs {
  lstat(abs: string): WorktreeStat;
  readlink(abs: string): string;
  readFile(abs: string, limit: number): Buffer;
}
export interface DiffSidesDeps extends FileDiffDeps { fs: WorktreeFs }

function readBounded(abs: string, limit: number): Buffer {
  const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buf = Buffer.alloc(limit + 1);
    let filled = 0;
    while (filled < buf.length) {
      const n = readSync(fd, buf, filled, buf.length - filled, null);
      if (n === 0) break;
      filled += n;
    }
    return buf.subarray(0, filled);
  } finally {
    closeSync(fd);
  }
}

/** The real filesystem: `readFile` opens with O_NOFOLLOW, so a file swapped for a symlink after `lstat` is refused. */
export const nodeWorktreeFs: WorktreeFs = {
  lstat: (abs) => lstatSync(abs),
  readlink: (abs) => readlinkSync(abs, 'utf8'),
  readFile: readBounded,
};

export const defaultDiffSidesDeps: DiffSidesDeps = { run: runGit, realpath: realpathSync, fs: nodeWorktreeFs };

const skipped = (reason: NonNullable<GitSideContent['skipped']>): GitSideContent => ({ text: null, skipped: reason });

function toContent(buf: Buffer): GitSideContent {
  if (buf.length > HIGHLIGHT_MAX_BYTES) return skipped('too-large');
  if (buf.subarray(0, BINARY_SCAN_BYTES).includes(0)) return skipped('binary');
  return { text: buf.toString('utf8') };
}

function readBlob(root: string, spec: string, run: GitRunner): GitSideContent | 'missing' {
  const r = run(root, ['cat-file', 'blob', spec], { maxBuffer: HIGHLIGHT_MAX_BYTES + 1, timeout: CONTENT_TIMEOUT_MS });
  if (r.tooLarge) return skipped('too-large');
  if (r.timedOut) return skipped('unavailable');
  if (r.status !== 0) return 'missing';
  return toContent(r.stdout);
}

function readHeadSide(root: string, path: string, run: GitRunner): GitSideContent {
  const side = readBlob(root, `HEAD:${path}`, run);
  return side === 'missing' ? skipped('absent') : side;
}

function readIndexSide(root: string, path: string, run: GitRunner): GitSideContent {
  const side = readBlob(root, `:0:${path}`, run);
  if (side !== 'missing') return side;
  const staged = run(root, ['ls-files', '--stage', '-z', '--', path], { maxBuffer: 64 * 1024, timeout: CONTENT_TIMEOUT_MS });
  // A path that is in the index but not at stage 0 is conflicted: it exists, but has no single version.
  if (staged.status !== 0 || staged.timedOut || staged.tooLarge || staged.stdout.length > 0) return skipped('unavailable');
  return skipped('absent');
}

function readWorktreeSide(root: string, path: string, fs: WorktreeFs): GitSideContent {
  const abs = join(root, path);
  try {
    const st = fs.lstat(abs);
    if (st.isSymbolicLink()) return { text: fs.readlink(abs) };
    if (!st.isFile()) return skipped('unavailable');
    if (st.size > HIGHLIGHT_MAX_BYTES) return skipped('too-large');
    return toContent(fs.readFile(abs, HIGHLIGHT_MAX_BYTES));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return skipped('absent');
    log.warn('[git:diff-sides] working-tree read failed; highlighting off for this side', { path, code });
    return skipped('unavailable');
  }
}

function readSides(root: string, kind: GitDiffKind, path: string, origPath: string | undefined, deps: DiffSidesDeps): { oldSide: GitSideContent; newSide: GitSideContent } {
  if (kind === 'staged') return { oldSide: readHeadSide(root, origPath ?? path, deps.run), newSide: readIndexSide(root, path, deps.run) };
  if (kind === 'unstaged') return { oldSide: readIndexSide(root, path, deps.run), newSide: readWorktreeSide(root, path, deps.fs) };
  return { oldSide: skipped('absent'), newSide: readWorktreeSide(root, path, deps.fs) };
}

/**
 * Read the diff and both sides for `req`. Paths are validated before any git call or file read
 * (throws `PathRejectedError`); a diff over 1 MiB gives `too-large` and no content read; a diff whose
 * sha1 equals `ifDiffHashNot` gives `unchanged` and no content read. Throws `GitCommandError` when the
 * diff itself cannot be read.
 */
export function readDiffSides(root: string, req: DiffSidesRequest, deps: DiffSidesDeps = defaultDiffSidesDeps): DiffSidesResponse {
  const path = toRepoRelativePath(root, req.path);
  const origPath = req.origPath === undefined ? undefined : toRepoRelativePath(root, req.origPath);
  if (req.kind !== 'staged') assertWorktreeContained(root, path, deps.realpath);
  const { diff, tooLarge } = readFileDiff(root, { path, origPath, staged: req.kind === 'staged', untracked: req.kind === 'untracked' }, deps);
  if (tooLarge) return { status: 'too-large' };
  const diffHash = createHash('sha1').update(diff).digest('hex');
  if (diffHash === req.ifDiffHashNot) return { status: 'unchanged' };
  return { status: 'ok', diff, diffHash, ...readSides(root, req.kind, path, origPath, deps) };
}
