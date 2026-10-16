/**
 * Canvas colour probe for the modal-glass and command-palette suites.
 *
 * The modal material is built from `color-mix()` and relative colour syntax
 * (`rgb(from …)`), which Chromium may serialise as `oklab()`, `color()` or
 * `rgba()`. Every colour here is painted on a 1x1 canvas by the browser
 * itself (`resolveColour`, mermaid-palette.ts) and read back as concrete
 * sRGB channels plus alpha, so assertions never depend on the syntax the
 * computed style happens to use. The read-back alpha is quantised to 1/255.
 */

import type { Locator, Page } from '@playwright/test';
import { resolveColour, type Rgba } from './mermaid-palette';
import { fmtColour, resolveToken } from './chrome-colour';

export { fmtColour, resolveColour, resolveToken, type Rgba };

/** One step of the canvas's 8-bit alpha channel. */
export const ALPHA_STEP = 1 / 255;

/** A computed colour property of an element, resolved through the canvas. */
export async function computedColour(win: Page, el: Locator, prop: 'color' | 'background-color'): Promise<Rgba> {
  const computed = await el.evaluate((node, p) => getComputedStyle(node).getPropertyValue(p), prop);
  return resolveColour(win, computed);
}

/** Whether a canvas-read alpha equals `expected` to within the canvas's quantisation (one 8-bit step). */
export function alphaMatches(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= ALPHA_STEP;
}

/**
 * The radius in px of the first `blur()` in a computed `filter` or `backdrop-filter`
 * value, or `null` when the value has no blur (including `none`).
 */
export function blurRadiusPx(filter: string): number | null {
  const m = /blur\(\s*([\d.]+)px\s*\)/.exec(filter);
  return m ? Number(m[1]) : null;
}
