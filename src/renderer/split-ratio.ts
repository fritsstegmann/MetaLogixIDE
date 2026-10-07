/**
 * Pure rules for the split shell's divider: the left pane's share of the row
 * as a ratio in 0.15–0.85, its default, sanitising a persisted value, the
 * keyboard step (rounded to two decimals so repeated presses never drift),
 * and the percentage exposed as the separator's `aria-valuenow`.
 */

export const SPLIT_RATIO_DEFAULT = 0.5;
export const SPLIT_RATIO_MIN = 0.15;
export const SPLIT_RATIO_MAX = 0.85;
export const SPLIT_RATIO_STEP = 0.02;

/** Holds a ratio inside the range so neither pane collapses. */
export function clampRatio(r: number): number {
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, r));
}

/** A persisted ratio made safe to render: an in-range number passes through, anything else is the default. */
export function sanitizeRatio(r: unknown): number {
  return typeof r === 'number' && r >= SPLIT_RATIO_MIN && r <= SPLIT_RATIO_MAX ? r : SPLIT_RATIO_DEFAULT;
}

/** One keyboard step left (-1) or right (1), clamped and rounded to two decimals. */
export function stepRatio(r: number, dir: -1 | 1): number {
  return clampRatio(Math.round((r + dir * SPLIT_RATIO_STEP) * 100) / 100);
}

/** The ratio as a whole percentage. */
export function ratioAriaValue(r: number): number {
  return Math.round(r * 100);
}
