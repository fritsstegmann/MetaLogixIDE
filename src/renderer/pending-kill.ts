/**
 * Bookkeeping for shells that a split close will kill once the right pane's fold-out finishes.
 * A close marks the shell, the pane's exit completion takes it (and only a marked shell is
 * taken, so "To tab" never kills), and a project switch flushes whatever is still waiting
 * because that exit will never complete.
 */

/** A shell awaiting its kill. */
export interface PendingShell {
  projectId: number;
  shellIndex: number;
}

/** The pending set: mark on close, take on exit, flush on project switch. */
export interface PendingKills {
  mark: (projectId: number, shellIndex: number) => void;
  takeIfPending: (projectId: number, shellIndex: number) => boolean;
  flushAll: () => PendingShell[];
}

/** Creates an empty pending set. */
export function createPendingKills(): PendingKills {
  const pending = new Map<string, PendingShell>();
  const keyOf = (projectId: number, shellIndex: number) => `${projectId}:${shellIndex}`;
  return {
    mark: (projectId, shellIndex) => { pending.set(keyOf(projectId, shellIndex), { projectId, shellIndex }); },
    takeIfPending: (projectId, shellIndex) => pending.delete(keyOf(projectId, shellIndex)),
    flushAll: () => {
      const all = [...pending.values()];
      pending.clear();
      return all;
    },
  };
}
