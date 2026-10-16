/**
 * A command row's content in the command palette: the category's stroke icon, the title, and the
 * shortcut as a `kbd` hint on the right when the command has one (AC9). The category is not repeated
 * inline: the row always sits under its category's group heading, which also labels it for assistive tech.
 */
import type { PaletteCommand } from '@renderer/command-palette-contract';
import { CategoryIcon } from './category-icons';

export function CommandRow({ command }: { readonly command: PaletteCommand }): React.JSX.Element {
  return (
    <>
      <CategoryIcon category={command.category} />
      <span className="min-w-0 flex-1 truncate">{command.title}</span>
      {command.hint && <kbd>{command.hint}</kbd>}
    </>
  );
}
