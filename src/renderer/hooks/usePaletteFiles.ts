/**
 * The command palette's async file provider (AC34, AC36). The list is loaded from `files:list-all`
 * the first time "@" mode is entered while the palette is open, and reused until the palette closes
 * or the project changes. `paletteFilesReducer` and `loadPaletteFiles` hold the logic; the hook
 * only wires them to React and the `api` wrapper.
 */
import { useEffect, useReducer } from 'react';
import { api } from '@renderer/api';
import { PALETTE_FILE_LIMIT, type PaletteFileEntry, type PaletteFilesState } from '@renderer/command-palette-contract';

export type PaletteFilesEvent =
  | { readonly type: 'enter'; readonly projectId: number | null }
  | { readonly type: 'loaded'; readonly files: readonly PaletteFileEntry[]; readonly truncated: boolean }
  | { readonly type: 'failed' }
  | { readonly type: 'reset' };

const IDLE: PaletteFilesState = { status: 'idle' };

/**
 * Next provider state. Entering "@" without a project is `no-project`; with one it starts a load
 * unless a list is already loaded or loading. Results only land on a load in flight, so a late
 * response after a reset is dropped.
 */
export function paletteFilesReducer(state: PaletteFilesState, event: PaletteFilesEvent): PaletteFilesState {
  switch (event.type) {
    case 'enter':
      if (event.projectId == null) return { status: 'no-project' };
      return state.status === 'ready' || state.status === 'loading' ? state : { status: 'loading' };
    case 'loaded':
      return state.status === 'loading' ? { status: 'ready', files: event.files, truncated: event.truncated } : state;
    case 'failed':
      return state.status === 'loading' ? { status: 'error' } : state;
    case 'reset':
      return IDLE;
  }
}

type ListAllFiles = (req: { projectId: number; limit: number }) => Promise<{ files: PaletteFileEntry[]; truncated: boolean }>;

/** Lists the project's files (capped at `PALETTE_FILE_LIMIT`) and returns the event to dispatch. */
export async function loadPaletteFiles(projectId: number, list: ListAllFiles): Promise<PaletteFilesEvent> {
  try {
    const { files, truncated } = await list({ projectId, limit: PALETTE_FILE_LIMIT });
    return { type: 'loaded', files, truncated };
  } catch (error) {
    console.error('[palette] files:list-all failed', error);
    return { type: 'failed' };
  }
}

const listAllFiles: ListAllFiles = (req) => api.invoke('files:list-all', req);

/**
 * File list for the palette. `open` is whether the palette is open, `active` whether it is in "@"
 * mode, `projectId` the selected project (or null). Closing or switching project forgets the list.
 */
export function usePaletteFiles(open: boolean, active: boolean, projectId: number | null): PaletteFilesState {
  const [state, dispatch] = useReducer(paletteFilesReducer, IDLE);

  useEffect(() => { dispatch({ type: 'reset' }); }, [open, projectId]);
  useEffect(() => {
    if (open && active) dispatch({ type: 'enter', projectId });
  }, [open, active, projectId]);

  const loading = state.status === 'loading';
  useEffect(() => {
    if (!loading || projectId == null) return;
    let live = true;
    void loadPaletteFiles(projectId, listAllFiles).then((event) => { if (live) dispatch(event); });
    return () => { live = false; };
  }, [loading, projectId]);

  return state;
}
