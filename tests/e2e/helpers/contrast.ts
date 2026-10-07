/**
 * Effective-colour oracle for the Settings board suite (tests/e2e/settings-board.spec.ts),
 * per spec AC22, AC32 and AC32a.
 *
 * "Effective background" is the dialog surface plus every fill layered on it between the
 * `role="dialog"` panel and the element, composited over opaque black (dark theme) or opaque
 * white (light theme). Nothing behind the panel (backdrop, app) takes part.
 *
 * The compositing is done by the browser: the layers' computed colours are painted in order
 * onto a 1x1 sRGB canvas over the base, and the pixel is read back. That is how Chromium
 * paints translucent fills, it reads any colour syntax the computed style produces
 * (`oklab()`, `color(srgb …)` from `color-mix()`), and it avoids the precision loss of
 * reading a low-alpha colour back on its own. Contrast and luminance are computed here.
 */

import type { Locator, Page } from '@playwright/test';
import { contrast, luminance, toHex, type Rgb } from './mermaid-palette';

export type Theme = 'dark' | 'light';

export interface Effective {
  /** Text colour painted over `bg`. */
  readonly fg: Rgb;
  /** Effective background under the element. */
  readonly bg: Rgb;
  /** The painted layers, outermost (dialog panel) first, as computed. */
  readonly layers: readonly string[];
  readonly color: string;
}

/**
 * Paints `layers` (outermost first) over the theme base and then `color` on top, returning
 * the background pixel and the text pixel. Throws on a colour the canvas rejects, so an
 * unresolved token cannot read as black.
 */
async function paint(win: Page, theme: Theme, layers: readonly string[], color: string): Promise<{ bg: Rgb; fg: Rgb }> {
  return win.evaluate(({ theme, layers, color }) => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    if (!ctx) throw new Error('no 2d context');
    const fill = (css: string): void => {
      ctx.fillStyle = '#010203';
      const sentinel = ctx.fillStyle;
      ctx.fillStyle = css;
      if (ctx.fillStyle === sentinel) throw new Error(`canvas rejected colour ${JSON.stringify(css)}`);
      ctx.fillRect(0, 0, 1, 1);
    };
    const read = (): { r: number; g: number; b: number } => {
      const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b };
    };
    fill(theme === 'dark' ? '#000000' : '#ffffff');
    for (const layer of layers) fill(layer);
    const bg = read();
    fill(color);
    return { bg, fg: read() };
  }, { theme, layers: [...layers], color });
}

/**
 * The effective background of `el` (AC32a) and its text colour over it. Throws if `el` is not
 * inside a `role="dialog"` panel or an ancestor below the panel has opacity < 1, which the
 * oracle does not model.
 */
export async function effectiveColours(win: Page, el: Locator, theme: Theme): Promise<Effective> {
  const { layers, color } = await el.evaluate((node) => {
    const chain: Element[] = [];
    let cur: Element | null = node;
    for (; cur; cur = cur.parentElement) {
      chain.push(cur);
      if (cur.getAttribute('role') === 'dialog') break;
    }
    if (!cur) throw new Error('element is not inside a role="dialog" panel');
    for (const a of chain) {
      const op = getComputedStyle(a).opacity;
      if (parseFloat(op) !== 1) throw new Error(`${a.tagName} has opacity ${op}; the oracle does not model it`);
    }
    return {
      layers: chain.reverse().map((a) => getComputedStyle(a).backgroundColor),
      color: getComputedStyle(node).color,
    };
  });
  const { bg, fg } = await paint(win, theme, layers, color);
  return { fg, bg, layers, color };
}

/** WCAG contrast of `el`'s text against its effective background. */
export async function textContrast(win: Page, el: Locator, theme: Theme): Promise<{ ratio: number; detail: string }> {
  const e = await effectiveColours(win, el, theme);
  const ratio = contrast(e.fg, e.bg);
  return { ratio, detail: `${toHex(e.fg)} on ${toHex(e.bg)} = ${ratio.toFixed(2)} (layers ${e.layers.join(' | ')})` };
}

/** WCAG relative luminance of `el`'s effective background (its own fill included). */
export async function backgroundLuminance(win: Page, el: Locator, theme: Theme): Promise<{ lum: number; hex: string }> {
  const e = await effectiveColours(win, el, theme);
  return { lum: luminance(e.bg), hex: toHex(e.bg) };
}

/** A CSS colour painted on its own over the theme base; used to check the oracle reads `oklab()`. */
export async function paintedOver(win: Page, theme: Theme, css: string): Promise<Rgb> {
  return (await paint(win, theme, [css], 'transparent')).bg;
}
