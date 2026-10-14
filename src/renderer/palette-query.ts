/**
 * Query parsing for the command palette: the first character of the raw query picks the search mode
 * ("@" files, "#" projects, ">" commands, anything else normal), and the remainder with its leading
 * spaces removed is the search text (AC39). A prefix character anywhere else is ordinary text.
 */
import type { PaletteMode, ParsePaletteQuery } from '@renderer/command-palette-contract';

const PREFIX_MODES: Readonly<Record<string, PaletteMode>> = { '@': 'files', '#': 'projects', '>': 'commands' };

export const parsePaletteQuery: ParsePaletteQuery = (raw) => {
  const mode = PREFIX_MODES[raw.charAt(0)];
  return mode ? { mode, text: raw.slice(1).trimStart() } : { mode: 'all', text: raw.trimStart() };
};
