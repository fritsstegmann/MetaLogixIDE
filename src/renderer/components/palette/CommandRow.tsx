/**
 * A command row's content in the command palette: the category's stroke icon, the title, the muted
 * category inline after it, and the shortcut as a `kbd` hint on the right when the command has one
 * (AC9).
 */
import type { PaletteCommand } from '@renderer/command-palette-contract';
import { CategoryIcon } from './category-icons';

export function CommandRow({ command }: { readonly command: PaletteCommand }): React.JSX.Element {
  return (
    <>
      <CategoryIcon category={command.category} />
      <span className="shrink-0 truncate font-medium max-w-[70%]">{command.title}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-[--modal-text-muted]">{command.category}</span>
      {command.hint && <kbd>{command.hint}</kbd>}
    </>
  );
}
