/**
 * Colour oracle for the shell chrome suites (chrome-dimensions.spec.ts).
 *
 * Chromium serialises `color-mix()` results as `oklab()` or `color()`. Every
 * colour here is resolved by the browser itself through `resolveColour`
 * (mermaid-palette.ts): it is painted on a 1x1 canvas and the pixel is read
 * back, so whatever syntax the computed style uses, the test sees concrete
 * sRGB channels and alpha.
 *
 * Canvas resolution, compositing and WCAG contrast live in mermaid-palette.ts.
 */

import type { Locator, Page } from '@playwright/test';
import type { EffectiveTheme } from '../../../src/renderer/markdown/contract';
import { contrast, over, readReferenceBackgrounds, resolveColour, toHex, type Rgb, type Rgba } from './mermaid-palette';

export { resolveColour };

/** A custom property resolved through a probe's computed `color`, then through the canvas. */
export async function resolveToken(win: Page, name: `--${string}`): Promise<Rgba> {
  const computed = await win.evaluate((n) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${n})`;
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);
  return resolveColour(win, computed);
}

/** The computed `color` or `background-color` of an element, resolved through the canvas. */
export async function elementColour(win: Page, el: Locator, prop: 'color' | 'background-color'): Promise<Rgba> {
  const computed = await el.evaluate((node, p) => getComputedStyle(node).getPropertyValue(p), prop);
  return resolveColour(win, computed);
}

/** Largest per-channel difference (0–255) between two resolved colours, alpha scaled to 255. */
export function colourDistance(a: Rgba, b: Rgba): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b), Math.abs(a.a - b.a) * 255);
}

/** `#rrggbb@alpha`, for failure messages. */
export function fmtColour(c: Rgba): string {
  return `${toHex(c)}@${c.a.toFixed(3)}`;
}

export interface BadgeContrast {
  /** Worst contrast across the theme's reference backgrounds. */
  ratio: number;
  fill: Rgba;
  text: Rgba;
  /** Backgrounds painted under the badge, innermost first (badge fill excluded). */
  under: Rgba[];
}

/**
 * Contrast of a badge's text against what it actually sits on: the badge
 * fill, over every painted ancestor up to (not including) `<body>` — which
 * includes the translucent `--surface-chrome` — over each of the theme's
 * reference window backgrounds (`readReferenceBackgrounds`, which already
 * stands for the `--bg` that `<html>` and `<body>` paint). Returns the worst.
 */
export async function badgeContrast(win: Page, badge: Locator, theme: EffectiveTheme): Promise<BadgeContrast> {
  const layers = await badge.evaluate((el) => {
    const out: { fill: string; text: string; under: string[] } = {
      fill: getComputedStyle(el).backgroundColor,
      text: getComputedStyle(el).color,
      under: [],
    };
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (parseFloat(cs.opacity) !== 1) throw new Error(`ancestor ${a.tagName} has opacity ${cs.opacity}; the oracle does not model it`);
      out.under.push(cs.backgroundColor);
    }
    return out;
  });
  const fill = await resolveColour(win, layers.fill);
  const text = await resolveColour(win, layers.text);
  const under: Rgba[] = [];
  for (const u of layers.under) under.push(await resolveColour(win, u));

  let ratio = Infinity;
  for (const ref of await readReferenceBackgrounds(win, theme)) {
    let bg: Rgb = ref;
    for (const layer of [...under].reverse()) bg = over(layer, bg);
    bg = over(fill, bg);
    ratio = Math.min(ratio, contrast(over(text, bg), bg));
  }
  return { ratio, fill, text, under };
}
