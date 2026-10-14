/**
 * AC23/AC24: the D1T modal material clears WCAG 4.5:1 for panel text, muted text and the
 * highlighted row, over both `--bg` and `--panel-strong`, in every palette x theme combination,
 * and the reduced-transparency (opaque) panel clears 4.5:1 for text and muted text too. Colours
 * and the D1T parameters (lift, alpha, scrim darken factor) are parsed straight out of
 * `styles.css`, using the composite model in `helpers/modal-composite.ts` (the same model the
 * design record's contrast table was built from), so a regression in either file fails this test.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  flatten,
  mix,
  modalSurface,
  over,
  ratio,
  reducedSurface,
  rgba,
  solid,
  unders,
  type Colour,
  type ModalParams,
  type ThemeColours,
} from './helpers/modal-composite';

const cssPath = resolve(__dirname, '../../../src/renderer/styles.css');
const css = readFileSync(cssPath, 'utf8');

function extractBlock(source: string, selector: RegExp): string {
  const m = selector.exec(source);
  if (!m) throw new Error(`block not found for ${selector}`);
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (depth > 0) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  return source.slice(start, i - 1);
}

function extractVar(block: string, name: string): string {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(block);
  const captured = m?.[1];
  if (captured === undefined) throw new Error(`${name} not found in block`);
  return captured.trim();
}

/** `rgba(r, g, b, a)` or `#rrggbb` -> Colour (0..1 channels). */
function parseColour(value: string): Colour {
  const rgbaMatch = /rgba?\(([^)]+)\)/.exec(value);
  if (rgbaMatch?.[1] !== undefined) {
    const parts = rgbaMatch[1].split(',').map((s) => parseFloat(s.trim()));
    const [r, g, b, a] = parts;
    if (r === undefined || g === undefined || b === undefined) throw new Error(`unparseable colour: ${value}`);
    return rgba(r, g, b, a ?? 1);
  }
  const hex = /^#([0-9a-fA-F]{6})$/.exec(value);
  if (hex?.[1] !== undefined) return solid(value);
  throw new Error(`unparseable colour: ${value}`);
}

const DARK_PALETTE_BLOCK = extractBlock(css, /:root,\s*:root\[data-theme="dark"\]\s*\{/);
const LIGHT_PALETTE_BLOCK = extractBlock(css, /:root\[data-theme="light"\]\s*\{/);
const PALETTE_BLOCKS: Record<string, { dark: string; light: string }> = {
  default: { dark: DARK_PALETTE_BLOCK, light: LIGHT_PALETTE_BLOCK },
  catppuccin: {
    dark: extractBlock(css, /:root\[data-palette="catppuccin"\]\s*\{/),
    light: extractBlock(css, /:root\[data-palette="catppuccin"\]\[data-theme="light"\]\s*\{/),
  },
  'rose-pine': {
    dark: extractBlock(css, /:root\[data-palette="rose-pine"\]\s*\{/),
    light: extractBlock(css, /:root\[data-palette="rose-pine"\]\[data-theme="light"\]\s*\{/),
  },
};

const modalSection = css.slice(css.indexOf('Modal material (D1T'));
const modalShared = extractBlock(modalSection, /:root\s*\{/);
const modalLightBlock = extractBlock(modalSection, /:root\[data-theme="light"\]\s*\{/);

/** Dark lift/alpha/scrim come from the shared block; light overrides them. */
function modalParams(dark: boolean): ModalParams {
  const block = dark ? modalShared : modalLightBlock;
  const lift = parseFloat(extractVar(block, '--modal-lift')) / 100;
  const panelAlpha = parseFloat(extractVar(block, '--modal-panel-alpha'));
  const scrim = extractVar(block, '--modal-scrim');
  if (dark) {
    const darken = /calc\(r \* ([\d.]+)\)/.exec(scrim)?.[1];
    const alpha = /\/\s*([\d.]+)\)\s*;?$/.exec(scrim)?.[1];
    if (darken === undefined || alpha === undefined) throw new Error(`could not parse dark --modal-scrim: ${scrim}`);
    return { scrimAlpha: parseFloat(alpha), scrimDarken: parseFloat(darken), lift, panelAlpha };
  }
  const alpha = /\/\s*([\d.]+)\)\s*;?$/.exec(scrim)?.[1];
  if (alpha === undefined) throw new Error(`could not parse light --modal-scrim: ${scrim}`);
  return { scrimAlpha: parseFloat(alpha), scrimDarken: 1, lift, panelAlpha };
}

const MODAL_PARAMS: Record<'dark' | 'light', ModalParams> = {
  dark: modalParams(true),
  light: modalParams(false),
};

interface Case {
  readonly palette: string;
  readonly dark: boolean;
  readonly label: string;
}

function makeCase(palette: string, dark: boolean): Case {
  return { palette, dark, label: `${palette}/${dark ? 'dark' : 'light'}` };
}

const CASES: readonly Case[] = [
  makeCase('default', true),
  makeCase('default', false),
  makeCase('catppuccin', true),
  makeCase('catppuccin', false),
  makeCase('rose-pine', true),
  makeCase('rose-pine', false),
];

function themeFor(c: Case): ThemeColours {
  const block = PALETTE_BLOCKS[c.palette]![c.dark ? 'dark' : 'light'];
  return {
    dark: c.dark,
    bg: parseColour(extractVar(block, '--bg')),
    panelStrong: parseColour(extractVar(block, '--panel-strong')),
  };
}

function textFor(c: Case): Colour {
  const block = PALETTE_BLOCKS[c.palette]![c.dark ? 'dark' : 'light'];
  return parseColour(extractVar(block, '--text'));
}

function textMutedFor(c: Case): Colour {
  const block = PALETTE_BLOCKS[c.palette]![c.dark ? 'dark' : 'light'];
  return parseColour(extractVar(block, '--text-muted'));
}

function accentFor(c: Case): Colour {
  const block = PALETTE_BLOCKS[c.palette]![c.dark ? 'dark' : 'light'];
  return parseColour(extractVar(block, '--accent'));
}

/** `--modal-text-muted` share of `--text` in `color-mix(in oklab, var(--text) N%, var(--text-muted))`. */
const MODAL_TEXT_MUTED_SHARE = (() => {
  const expr = extractVar(modalShared, '--modal-text-muted');
  const pct = /var\(--text\)\s*([\d.]+)%/.exec(expr)?.[1];
  if (pct === undefined) throw new Error(`could not parse --modal-text-muted share: ${expr}`);
  return parseFloat(pct) / 100;
})();

/** `--accent-soft` alpha in `color-mix(in oklab, var(--accent) N%, transparent)`, read from the shared surface-tokens block. */
const ACCENT_SOFT_ALPHA = (() => {
  const surfaceTokensBlock = extractBlock(css, /:root\s*\{\s*--surface-chrome:/);
  const expr = extractVar(surfaceTokensBlock, '--accent-soft');
  const pct = /var\(--accent\)\s*([\d.]+)%/.exec(expr)?.[1];
  if (pct === undefined) throw new Error(`could not parse --accent-soft alpha: ${expr}`);
  return parseFloat(pct) / 100;
})();

function modalTextMuted(c: Case): Colour {
  return mix(textFor(c), textMutedFor(c), MODAL_TEXT_MUTED_SHARE);
}

/** The highlighted row: --text over --accent-soft (the --modal-row-active fill) over the panel surface. */
function highlighted(c: Case, panelSurface: Colour): Colour {
  const fill: Colour = { c: accentFor(c).c, a: ACCENT_SOFT_ALPHA };
  return over(fill, panelSurface);
}

const GATE = 4.5;

describe.each(CASES)('$label AC23 contrast', (c) => {
  const label = c.label;
  const theme = themeFor(c);
  const params = MODAL_PARAMS[c.dark ? 'dark' : 'light'];
  const base = unders(theme);
  const text = textFor(c);
  const muted = modalTextMuted(c);

  it.each(['bg', 'panelStrong'] as const)(`${label}: text clears ${GATE}:1 over %s`, (under) => {
    const surface = modalSurface(theme, params, base[under]);
    expect(ratio(text, surface)).toBeGreaterThanOrEqual(GATE);
  });

  it.each(['bg', 'panelStrong'] as const)(`${label}: muted text clears ${GATE}:1 over %s`, (under) => {
    const surface = modalSurface(theme, params, base[under]);
    expect(ratio(muted, surface)).toBeGreaterThanOrEqual(GATE);
  });

  it.each(['bg', 'panelStrong'] as const)(`${label}: the highlighted row clears ${GATE}:1 over %s`, (under) => {
    const surface = modalSurface(theme, params, base[under]);
    const row = highlighted(c, surface);
    expect(ratio(text, row)).toBeGreaterThanOrEqual(GATE);
  });

  it.each(['bg', 'panelStrong'] as const)(`${label}: reduced transparency text clears ${GATE}:1 over %s`, (under) => {
    const surface = reducedSurface(theme, params, base[under]);
    expect(ratio(text, surface)).toBeGreaterThanOrEqual(GATE);
  });

  it.each(['bg', 'panelStrong'] as const)(`${label}: reduced transparency muted text clears ${GATE}:1 over %s`, (under) => {
    const surface = reducedSurface(theme, params, base[under]);
    expect(ratio(muted, surface)).toBeGreaterThanOrEqual(GATE);
  });
});

describe('flatten sanity (model smoke)', () => {
  it('an opaque colour flattens to itself', () => {
    const opaque = solid('#112233');
    expect(flatten(opaque, true)).toEqual(opaque);
  });
});
