/**
 * A file row's content in the command palette's "@" mode (AC34): file name, the muted relative path
 * inline after it, and the `↩` hint when the row is highlighted.
 */
import type { PaletteFileEntry } from '@renderer/command-palette-contract';

interface FileRowProps {
  readonly file: PaletteFileEntry;
  readonly active: boolean;
}

export function FileRow({ file, active }: FileRowProps): React.JSX.Element {
  return (
    <>
      <span className="shrink-0 truncate max-w-[50%]">{file.name}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-[--modal-text-muted]">{file.relPath}</span>
      {active && <kbd>↩</kbd>}
    </>
  );
}
