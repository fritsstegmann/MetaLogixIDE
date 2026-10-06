# Fonts

MetaLogix IDE has separate font preferences for application text and terminal text. Open **Settings → General → Fonts** to change them (`src/renderer/components/Settings.tsx:277-333`).

## UI font

The UI font applies to navigation, labels, controls, chat prose, and rendered Markdown prose. Source editors, source previews, paths, keyboard shortcuts, and code spans keep the built-in monospace stack (`src/renderer/styles.css:413-415`, `src/renderer/components/FilesTab.tsx:698-720`).

## Terminal font

The Terminal font applies to all integrated terminals, including split and popped-out terminals. A live change keeps the terminal process, scrollback, selection, and input, then remeasures and repaints the terminal (`src/renderer/components/ShellTab.tsx:337-349`, `src/renderer/terminal-font-update.ts:108-139`).

Terminals include **Symbols Nerd Font Mono v3.4.0** as a bundled fallback for private-use Nerd Font icons. Normal text keeps the existing system stack or your selected family. A selected font that already contains an icon takes precedence. The bundled face is restricted to private-use Unicode ranges, so it does not replace ordinary letters, numbers, or punctuation. Reset keeps this icon fallback.

The app loads the symbols before opening or repainting a terminal, including split and popout terminals. The font and its MIT license ship inside the application; no OS installation or runtime download is required. The upstream release is https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.4.0.

## Select an installed font

1. Open **Settings → General → Fonts**.
2. Select **Choose installed font** below **UI font** or **Terminal font**.
3. Allow font access if requested.
4. Search the installed families. Each row shows a sample in that font.
5. Select a row to apply it. The main preview and availability status update.

Font discovery runs only after the button action. The app keeps only family names in memory and does not read font files (`src/renderer/fonts/local-font-access.ts:49-60`).

If discovery is unsupported, denied, or fails, select **Retry loading installed fonts** to try again without closing Settings, or enter the exact installed family name manually. Settings reports availability as unknown until discovery succeeds. If successful discovery does not list a saved family, Settings reports that family as unavailable and keeps the saved value.

The list includes all installed families for both preferences; terminal selection does not hide proportional fonts or guess whether a family is a Nerd Font. Use Tab and Enter or Space to select a row. Escape closes the installed-font panel without closing Settings. Reset and manual entry remain available.

## Reset a font

Select **Reset** beside one preference. Reset changes only that preference and restores its built-in fallback stack (`src/renderer/components/FontControl.tsx:131-147`).

A font name can contain printable punctuation and non-ASCII characters. The app trims outer whitespace and rejects empty names, C0 control characters, and names longer than 256 Unicode code points (`src/shared/font-settings.ts:16-32`).
