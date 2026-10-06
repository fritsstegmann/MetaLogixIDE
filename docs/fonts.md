# Fonts

MetaLogix IDE has separate font preferences for application text and terminal text. Open **Settings → General → Fonts** to change them (`src/renderer/components/Settings.tsx:300-341`).

## UI font

The UI font applies to navigation, labels, controls, chat prose, and rendered Markdown prose. Source editors, source previews, paths, keyboard shortcuts, and code spans keep the built-in monospace stack (`src/renderer/styles.css:413-415`, `src/renderer/components/FilesTab.tsx:698-720`).

## Terminal font

The Terminal font applies to all integrated terminals, including split and popped-out terminals. A live change keeps the terminal process, scrollback, selection, and input, then remeasures and repaints the terminal (`src/renderer/components/ShellTab.tsx:337-349`, `src/renderer/terminal-font-update.ts:108-139`).

Terminals include **Symbols Nerd Font Mono v3.4.0** as a bundled fallback for private-use Nerd Font icons. Normal text keeps the existing system stack or your selected family. A selected font that already contains an icon takes precedence. The bundled face is restricted to private-use Unicode ranges, so it does not replace ordinary letters, numbers, or punctuation. **System default** keeps this icon fallback.

The app loads the symbols before opening or repainting a terminal, including split and popout terminals. The font and its MIT license ship inside the application; no OS installation or runtime download is required. The upstream release is https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.4.0.

## Choose a font

Each preference is one field: **Interface** for application text and **Terminal** for terminals (`src/renderer/components/FontControl.tsx`).

1. Open **Settings → General → Fonts**.
2. Click the **Interface** or **Terminal** field. A list opens with **System default** first, then every installed family drawn in its own face.
3. Allow font access if requested.
4. Type to filter the list. If the text does not match an installed family exactly, the list also offers **Use “…”** to save the typed name as an exact family. While you type, the highlight goes to the family whose name matches exactly, then to one that starts with the text, then to the first that contains it.
5. Click an entry, or use the arrow keys and Enter. The preview line under the field updates.

The field shows the saved family in that font. Enter on a field you have not changed saves nothing. Escape closes the list, restores the saved name, and keeps Settings open. Leaving the field saves exactly what Enter would.

Font discovery runs the first time a list opens in a Settings session; focusing a field opens its list. The app keeps only family names in memory and does not read font files (`src/renderer/fonts/local-font-access.ts:49-60`).

If discovery is unsupported, denied, or fails, the list says so and shows **Retry**; reopening the list also tries again. You can still type an exact installed family name. The status under the field reports availability as unknown until discovery succeeds. If successful discovery does not list a saved family, the status reports that family as unavailable and keeps the saved value. The status line is empty when there is nothing to report.

The list includes all installed families for both preferences; terminal selection does not hide proportional fonts or guess whether a family is a Nerd Font.

## Return to the system default

Choose **System default** at the top of the list, or clear the field and press Enter. This changes only that preference and restores its built-in fallback stack.

A font name can contain printable punctuation and non-ASCII characters. The app trims outer whitespace and rejects C0 control characters and names longer than 256 Unicode code points (`src/shared/font-settings.ts:16-32`).
