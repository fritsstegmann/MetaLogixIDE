import type { GitFileStatus } from '@shared/ipc-contract';

const STATUS_TEXT_CLASS: Partial<Record<GitFileStatus, string>> = {
  M: 'text-amber-400',
  A: 'text-emerald-400',
  D: 'text-rose-400',
  '?': 'text-sky-400',
};

/** Tailwind text colour for a one-letter git status, shared by the Git panel and the Diff tab so a status looks the same in both (spec AC8). */
export function gitStatusTextClass(status: GitFileStatus): string {
  return STATUS_TEXT_CLASS[status] ?? 'text-[--text-muted]';
}
