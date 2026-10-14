/**
 * Pure keydown routing for the command palette: maps a key event and whether the palette is open
 * to what App's global listener does. ⌘K / Ctrl-K toggles, ⌘⇧P opens seeded with ">", ⌘P opens
 * seeded with "@", any other mod-chord is swallowed while the palette is open so no second overlay
 * stacks on it (AC5), and everything else passes through to the existing shortcuts.
 */
import type { PaletteKeyAction, PaletteKeyActionFn } from './command-palette-contract';

const PASS: PaletteKeyAction = { kind: 'pass' };
const SWALLOW: PaletteKeyAction = { kind: 'swallow' };

const CHORDS: ReadonlyMap<string, PaletteKeyAction> = new Map<string, PaletteKeyAction>([
  ['k', { kind: 'toggle' }],
  ['p', { kind: 'open', seed: '@' }],
  ['shift+p', { kind: 'open', seed: '>' }],
]);

export const paletteKeyAction: PaletteKeyActionFn = (e, isOpen): PaletteKeyAction => {
  if (!(e.metaKey || e.ctrlKey)) return PASS;
  const chord = `${e.altKey ? 'alt+' : ''}${e.shiftKey ? 'shift+' : ''}${e.key.toLowerCase()}`;
  return CHORDS.get(chord) ?? (isOpen ? SWALLOW : PASS);
};
