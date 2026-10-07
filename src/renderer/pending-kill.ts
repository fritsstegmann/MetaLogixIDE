/**
 * Bookkeeping for shells that a split close kills once the right pane's fold-out finishes.
 * A close marks the shell, the pane's exit completion takes it (and only a marked shell is
 * taken, so "To tab" never kills), and a project switch flushes whatever is still waiting
 * because that exit will never complete. A marked shell stays `hidden` from the tab strip until
 * `settle` sees it gone from the alive list (or `forget` drops it after a failed kill), so its
 * chip never shows while it folds away or dies, and a reused index shows again.
 */

/** A shell awaiting its kill. */
export interface PendingShell {
  projectId: number;
  shellIndex: number;
}

/** The pending set: mark on close, take on exit, flush on project switch, hide until settled. */
export interface PendingKills {
  mark: (projectId: number, shellIndex: number) => void;
  takeIfPending: (projectId: number, shellIndex: number) => boolean;
  flushAll: () => PendingShell[];
  hidden: (projectId: number) => number[];
  settle: (projectId: number, alive: readonly number[]) => void;
  forget: (projectId: number, shellIndex: number) => void;
}

interface Entry extends PendingShell {
  killing: boolean;
}

/** Creates an empty pending set. */
export function createPendingKills(): PendingKills {
  const entries = new Map<string, Entry>();
  const keyOf = (projectId: number, shellIndex: number) => `${projectId}:${shellIndex}`;
  const toKilling = (e: Entry): PendingShell => {
    e.killing = true;
    return { projectId: e.projectId, shellIndex: e.shellIndex };
  };
  return {
    mark: (projectId, shellIndex) => { entries.set(keyOf(projectId, shellIndex), { projectId, shellIndex, killing: false }); },
    takeIfPending: (projectId, shellIndex) => {
      const e = entries.get(keyOf(projectId, shellIndex));
      if (!e || e.killing) return false;
      toKilling(e);
      return true;
    },
    flushAll: () => [...entries.values()].filter((e) => !e.killing).map(toKilling),
    hidden: (projectId) => [...entries.values()].filter((e) => e.projectId === projectId).map((e) => e.shellIndex),
    settle: (projectId, alive) => {
      for (const [key, e] of entries) {
        if (e.projectId === projectId && e.killing && !alive.includes(e.shellIndex)) entries.delete(key);
      }
    },
    forget: (projectId, shellIndex) => { entries.delete(keyOf(projectId, shellIndex)); },
  };
}
