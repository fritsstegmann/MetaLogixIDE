/**
 * Pure keydown routing for the command palette: maps a key event and whether the palette is open
 * to what App's global listener does. ⌘K / Ctrl-K toggles, ⌘⇧P opens seeded with ">", ⌘P opens
 * seeded with "@", any other mod-chord is swallowed while the palette is open so no second overlay
 * stacks on it (AC5), and everything else passes through to the existing shortcuts.
 */
import type { PaletteKeyAction, PaletteKeyActionFn } from './command-palette-contract';

export const paletteKeyAction: PaletteKeyActionFn = (e, isOpen): PaletteKeyAction => {
  if (!(e.metaKey || e.ctrlKey)) return { kind: 'pass' };
  const k = e.key.toLowerCase();
  if (k === 'k' && !e.shiftKey && !e.altKey) return { kind: 'toggle' };
  if (k === 'p' && !e.altKey) return { kind: 'open', seed: e.shiftKey ? '>' : '@' };
  return isOpen ? { kind: 'swallow' } : { kind: 'pass' };
};
