/**
 * Carries a file open across a project switch. A click on a terminal path or preview in another project records the
 * open, the main window's selection effect takes it when the selection lands, and the open applies in that same effect,
 * so it never depends on when React flushes the effect relative to the switch's IPC replies.
 */

/** A file to open once its project is selected. */
export interface FileOpen {
  relPath: string;
  line: number | null;
}

/** The pending open across a project switch; see {@link createPendingFileOpen}. */
export interface PendingFileOpen {
  request: (projectId: number, open: FileOpen) => void;
  pickSettled: (projectId: number, selected: boolean) => void;
  take: (selectedProjectId: number | null) => FileOpen | null;
}

/**
 * Creates the pending open. `request` records an open for a project; `take`, called whenever the selected project
 * changes, returns it when the selection is that project and drops it either way; `pickSettled` drops it when the
 * switch to its project did not select it (failed or superseded), so a later manual selection never opens it.
 */
export function createPendingFileOpen(): PendingFileOpen {
  let pending: (FileOpen & { projectId: number }) | null = null;
  return {
    request: (projectId, open) => { pending = { projectId, ...open }; },
    pickSettled: (projectId, selected) => {
      if (!selected && pending?.projectId === projectId) pending = null;
    },
    take: (selectedProjectId) => {
      const p = pending;
      pending = null;
      return p && p.projectId === selectedProjectId ? { relPath: p.relPath, line: p.line } : null;
    },
  };
}
