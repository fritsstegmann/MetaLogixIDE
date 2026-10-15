/**
 * Pure keydown routing for the command palette: maps a key event, whether the palette is open and
 * the shortcut platform (default: the runtime platform) to what App's global listener does. Only the
 * platform modifier counts (⌘ on mac, Ctrl elsewhere; see `isPrimaryMod`). mod+K toggles, mod+Shift+P
 * opens seeded with ">", mod+P opens seeded with "@", any other mod-chord is swallowed while the
 * palette is open so no second overlay stacks on it (AC5), and everything else passes through to the
 * existing shortcuts.
 */
import type { PaletteKeyAction, PaletteKeyActionFn } from './command-palette-contract';
import { chordKey, isPrimaryMod } from './shortcut-match';
import { RUNTIME_SHORTCUT_PLATFORM } from './shortcut-platform';

const PASS: PaletteKeyAction = { kind: 'pass' };
const SWALLOW: PaletteKeyAction = { kind: 'swallow' };

const CHORDS: ReadonlyMap<string, PaletteKeyAction> = new Map<string, PaletteKeyAction>([
  ['k', { kind: 'toggle' }],
  ['p', { kind: 'open', seed: '@' }],
  ['shift+p', { kind: 'open', seed: '>' }],
]);

export const paletteKeyAction: PaletteKeyActionFn = (
  e,
  isOpen,
  platform = RUNTIME_SHORTCUT_PLATFORM,
): PaletteKeyAction => {
  if (!isPrimaryMod(e, platform)) return PASS;
  return CHORDS.get(chordKey(e)) ?? (isOpen ? SWALLOW : PASS);
};
