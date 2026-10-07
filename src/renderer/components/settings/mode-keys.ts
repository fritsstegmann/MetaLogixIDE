import type { ThemeMode } from '@renderer/hooks/useTheme';

/** Mode radio order, left to right. */
export const MODE_ORDER: readonly ThemeMode[] = ['system', 'light', 'dark'];

const STEP: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/** Mode the radiogroup moves to for `key` (arrows step through MODE_ORDER with wrap-around), or null when the key is not a move. */
export function modeAfterKey(mode: ThemeMode, key: string): ThemeMode | null {
  const step = Object.hasOwn(STEP, key) ? STEP[key] : undefined;
  if (step === undefined) return null;
  const count = MODE_ORDER.length;
  const next = (MODE_ORDER.indexOf(mode) + step + count) % count;
  return MODE_ORDER[next] ?? null;
}
