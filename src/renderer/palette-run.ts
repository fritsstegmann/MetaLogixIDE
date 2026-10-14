/**
 * Running what the user picked in the command palette. `runSafely` turns a command's synchronous
 * throw or async rejection into a single `onError` call (AC16); `runPaletteRow` closes the palette
 * and then acts on the row: picks a project (or nothing, for the current one, AC8), opens a file
 * (AC35) or runs a command safely.
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
  readonly onPickFile: (relPath: string) => void;
  readonly onCommandError: (error: unknown) => void;
}

/** Closes the palette, then acts on `row`; resolves once a command has settled, never rejects. */
export async function runPaletteRow(row: PaletteRow, h: PaletteRowHandlers): Promise<void> {
  h.onClose();
  if (row.kind === 'command') return runSafely(row.command.run, h.onCommandError);
  if (row.kind === 'file') h.onPickFile(row.file.relPath);
  else if (!row.current) h.onPickProject(row.project);
}
