/**
 * Paths the Git panel sends to `git:unstage` (spec AC33). A staged rename is unstaged by restoring both its new and
 * its old path, so `git restore --staged` puts back the deletion of the old path as well as the addition of the new.
 */
import type { GitChangeEntry } from '@shared/ipc-contract';

/** The paths to unstage `entries`, in order: each entry's path, followed by its old path when it is a rename. */
export function unstagePaths(entries: readonly GitChangeEntry[]): string[] {
  return entries.flatMap((e) => (e.origPath === undefined ? [e.path] : [e.path, e.origPath]));
}
