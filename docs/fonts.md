# Fonts

MetaLogix IDE has separate font preferences for application text and terminal text. Open **Settings → General → Fonts** to change them (`src/renderer/components/Settings.tsx:277-333`).

## UI font

The UI font applies to navigation, labels, controls, chat prose, and rendered Markdown prose. Source editors, source previews, paths, keyboard shortcuts, and code spans keep the built-in monospace stack (`src/renderer/styles.css:413-415`, `src/renderer/components/FilesTab.tsx:698-720`).

## Terminal font

The Terminal font applies to all integrated terminals, including split and popped-out terminals. A live change keeps the terminal process, scrollback, selection, and input, then remeasures and repaints the terminal (`src/renderer/components/ShellTab.tsx:337-349`, `src/renderer/terminal-font-update.ts:108-139`).

Install a Nerd Font on the host before you select it. MetaLogix IDE does not download or bundle fonts. A Nerd Font icon renders only when the selected font contains that private-use glyph.

## Select an installed font

1. Open **Settings → General → Fonts**.
2. Select **Load installed fonts**.
3. Allow font access when the operating system requests it.
4. Enter or select a family in **UI font** or **Terminal font**.

Font discovery runs only after the button action. The app keeps only family names in memory and does not read font files (`src/renderer/fonts/local-font-access.ts:49-60`).

If discovery is unsupported or denied, enter the exact installed family name. Settings reports availability as unknown. If discovery succeeds and does not list a saved family, Settings reports that family as unavailable and keeps the saved value (`src/renderer/components/FontControl.tsx:55-73`).

## Reset a font

Select **Reset** beside one preference. Reset changes only that preference and restores its built-in fallback stack (`src/renderer/components/FontControl.tsx:131-147`).

A font name can contain printable punctuation and non-ASCII characters. The app trims outer whitespace and rejects empty names, C0 control characters, and names longer than 256 Unicode code points (`src/shared/font-settings.ts:16-32`).
