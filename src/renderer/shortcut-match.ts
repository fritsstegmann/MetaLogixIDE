/**
 * Platform modifier matching shared by every pure key router. `isPrimaryMod` is ⌘ without Ctrl on
 * mac and Ctrl without Super elsewhere; `chordKey` normalises the rest of a chord (Alt, Shift and
 * the lower-cased key, e.g. `alt+shift+p`) so routers can look actions up in a table.
 */
import type { IsPrimaryModFn, ShortcutKeyLike } from './shortcut-contract';

export const isPrimaryMod: IsPrimaryModFn = (e, platform) =>
  platform === 'mac' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;

/** Lookup key for a chord, ignoring Cmd/Ctrl: optional `alt+`, optional `shift+`, lower-cased key. */
export function chordKey(e: ShortcutKeyLike): string {
  return `${e.altKey ? 'alt+' : ''}${e.shiftKey ? 'shift+' : ''}${e.key.toLowerCase()}`;
}
