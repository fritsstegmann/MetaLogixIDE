/**
 * Pure parser for `git status --porcelain=v1 -z --branch` output, used by the Git panel and the Diff
 * tab (spec AC7, AC9, AC10, AC19, AC33). With `-z` git never quotes paths, every field ends in NUL,
 * and a rename or copy record is `XY NEW\0ORIG\0`.
 */
import type { GitChangeEntry, GitFileStatus } from './ipc-contract';

export interface GitPanelStatus {
  branch: string | null; ahead: number; behind: number;
  staged: GitChangeEntry[]; unstaged: GitChangeEntry[]; untracked: string[];
}

type Header = Pick<GitPanelStatus, 'branch' | 'ahead' | 'behind'>;

function parseHeader(body: string): Header {
  if (body.startsWith('HEAD (no branch)')) return { branch: null, ahead: 0, behind: 0 };
  const name = body.startsWith('No commits yet on ') ? body.slice('No commits yet on '.length) : body;
  const end = [name.indexOf('...'), name.indexOf(' [')].filter((i) => i >= 0);
  const branch = end.length > 0 ? name.slice(0, Math.min(...end)) : name;
  const ahead = /\[(?:.*, )?ahead (\d+)/.exec(name);
  const behind = /\[(?:.*, )?behind (\d+)/.exec(name);
  return { branch, ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0 };
}

function normalise(code: string): GitFileStatus {
  if (code === 'C') return 'R';
  if (code === 'M' || code === 'A' || code === 'D' || code === 'R' || code === 'U') return code;
  return 'M';
}

function entry(path: string, code: string, origPath: string | undefined): GitChangeEntry {
  return isRenameOrCopy(code) && origPath !== undefined ? { path, status: normalise(code), origPath } : { path, status: normalise(code) };
}

function isRenameOrCopy(code: string): boolean {
  return code === 'R' || code === 'C';
}

function pushChange(out: GitPanelStatus, path: string, x: string, y: string, origPath: string | undefined): void {
  if (x !== ' ') out.staged.push(entry(path, x, origPath));
  if (y !== ' ') out.unstaged.push(entry(path, y, origPath));
}

/** Adds the change record at `fields[i]` to `out` and returns the index of its last field (the old path of a rename). */
function parseRecord(fields: readonly string[], i: number, out: GitPanelStatus): number {
  const field = fields[i]!;
  const x = field[0]!;
  const y = field[1]!;
  const path = field.slice(3);
  if (x === '?' || x === '!') {
    if (x === '?') out.untracked.push(path);
    return i;
  }
  const last = isRenameOrCopy(x) || isRenameOrCopy(y) ? i + 1 : i;
  pushChange(out, path, x, y, last > i ? fields[last] : undefined);
  return last;
}

/**
 * Parse the raw `-z` output. Index-column codes go to `staged` and worktree-column codes to
 * `unstaged`, so `MM` and `UU` appear in both; `??` goes to `untracked`; `!!` is skipped; renames and
 * copies carry `origPath` and show as `R`; unknown letters show as `M`.
 */
export function parseGitPanelStatus(raw: string): GitPanelStatus {
  const out: GitPanelStatus = { branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] };
  const fields = raw.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.startsWith('## ')) Object.assign(out, parseHeader(field.slice(3)));
    else if (field.length >= 4) i = parseRecord(fields, i, out);
  }
  return out;
}
