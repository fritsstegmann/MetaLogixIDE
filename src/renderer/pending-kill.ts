/**
 * Bookkeeping for split shells that something must happen to once the right pane's fold-out
 * finishes: the shells a close kills, and the shell "To tab" activates. A shell is marked when
 * the pane leaves, taken when its exit completes (only a marked shell is taken), and flushed
 * when the shell area unmounts because that exit will never complete. `takeAll` takes what is
 * still pending once every exit has settled, for a pane that was queued and never mounted.
 * A marked shell stays `hidden` from the tab strip until `forget`; `killAndForget` forgets it
 * when its kill settles, so a new shell that reuses the index shows at once.
 */

/** A shell awaiting its fold-out. */
export interface PendingShell {
  projectId: number;
  shellIndex: number;
}

/** The pending set: mark, take on exit, take or flush the rest, hide until forgotten. */
export interface PendingShells {
  mark: (projectId: number, shellIndex: number) => void;
  takeIfPending: (projectId: number, shellIndex: number) => boolean;
  takeAll: (projectId: number) => PendingShell[];
  flushAll: () => PendingShell[];
  hidden: (projectId: number) => number[];
  forget: (projectId: number, shellIndex: number) => void;
}

interface Entry extends PendingShell {
  taken: boolean;
}

/** Creates an empty pending set. */
export function createPendingShells(): PendingShells {
  const entries = new Map<string, Entry>();
  const keyOf = (projectId: number, shellIndex: number) => `${projectId}:${shellIndex}`;
  const take = (e: Entry): PendingShell => {
    e.taken = true;
    return { projectId: e.projectId, shellIndex: e.shellIndex };
  };
  const untaken = (projectId?: number) =>
    [...entries.values()].filter((e) => !e.taken && (projectId === undefined || e.projectId === projectId));
  return {
    mark: (projectId, shellIndex) => { entries.set(keyOf(projectId, shellIndex), { projectId, shellIndex, taken: false }); },
    takeIfPending: (projectId, shellIndex) => {
      const e = entries.get(keyOf(projectId, shellIndex));
      if (!e || e.taken) return false;
      take(e);
      return true;
    },
    takeAll: (projectId) => untaken(projectId).map(take),
    flushAll: () => untaken().map(take),
    hidden: (projectId) => [...entries.values()].filter((e) => e.projectId === projectId).map((e) => e.shellIndex),
    forget: (projectId, shellIndex) => { entries.delete(keyOf(projectId, shellIndex)); },
  };
}

/** Kills a taken shell and forgets it once the kill settles; a shell that is already gone is fine. */
export async function killAndForget(
  pending: PendingShells,
  shell: PendingShell,
  kill: (shell: PendingShell) => Promise<unknown>,
): Promise<void> {
  try {
    await kill(shell);
  } catch {
    // The shell may already be gone; either way the kill has settled and it is no longer hidden.
  } finally {
    pending.forget(shell.projectId, shell.shellIndex);
  }
}
