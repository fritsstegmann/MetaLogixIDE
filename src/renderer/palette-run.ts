/**
 * Running what the user picked in the command palette. `runSafely` turns a command's synchronous
 * throw or async rejection into a single `onError` call (AC16); `runPaletteRow` closes the palette
 * and then acts on the row: picks a project (or hands the current one to `onPickCurrent`, which
 * focuses its terminal, AC8/R13), opens a file (AC35) or runs a command safely. `restoresOpenerOnClose` is the
 * close-time focus decision (AC2).
 */
import type { PaletteRow, RunSafely } from '@renderer/command-palette-contract';
import type { Project } from '@shared/types';

export const runSafely: RunSafely = async (run, onError) => {
  try {
    await run();
  } catch (error) {
    onError(error);
  }
};

/** Callbacks `runPaletteRow` dispatches to. */
export interface PaletteRowHandlers {
  readonly onClose: () => void;
  readonly onPickProject: (project: Project) => void;
  readonly onPickCurrent: (project: Project) => void;
  readonly onPickFile: (relPath: string) => void;
  readonly onCommandError: (error: unknown) => void;
}

/** Closes the palette, then acts on `row`; resolves once a command has settled, never rejects. */
export async function runPaletteRow(row: PaletteRow, h: PaletteRowHandlers): Promise<void> {
  h.onClose();
  if (row.kind === 'command') return runSafely(row.command.run, h.onCommandError);
  if (row.kind === 'file') h.onPickFile(row.file.relPath);
  else if (row.current) h.onPickCurrent(row.project);
  else h.onPickProject(row.project);
}

/**
 * Whether a closing palette gives focus back to the element that had it on open (AC2). `picked` is
 * the kind of row that closed it (`null` for Esc, ⌘K or the backdrop); `focusLost` is true when
 * focus went down with the palette (nothing but the body holds it). Project and file picks never
 * restore, since their handlers place focus themselves (AC8, AC35); otherwise focus is restored only
 * if nothing else, such as a modal a command opened (AC9), has already taken it.
 */
export function restoresOpenerOnClose(picked: PaletteRow['kind'] | null, focusLost: boolean): boolean {
  return focusLost && (picked === null || picked === 'command');
}
