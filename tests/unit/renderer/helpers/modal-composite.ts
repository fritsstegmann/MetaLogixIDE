/**
 * The D1T modal contrast model (a port of the design's `design-contrast.mjs`), shared by the
 * modal-contrast (AC23) and palette dot-contrast (AC7) tests.
 *
 * Model: Default's translucent `--bg` / `--panel-strong` are first flattened over a macOS
 * vibrancy stand-in (#282828 dark, #e8e8e8 light). The scrim is composited over that base, then
 * the panel over the scrim. The panel is `--panel-strong` made opaque and mixed toward white in
 * oklab by the lift, at the panel alpha. Reduced transparency is the opaque panel over the base.
 */

export interface Colour {
  /** sRGB channels, 0..1. */
  readonly c: readonly [number, number, number];
  /** Alpha, 0..1. */
  readonly a: number;
}

export interface ModalParams {
  /** Scrim alpha. */
  readonly scrimAlpha: number;
  /** Dark scrim darkens the flattened `--bg` by this factor (light themes use `--bg` as is). */
  readonly scrimDarken: number;
  /** Panel lift toward white, 0..1. */
  readonly lift: number;
  readonly panelAlpha: number;
}

export const VIBRANCY_DARK: Colour = solid('#282828');
export const VIBRANCY_LIGHT: Colour = solid('#e8e8e8');

export function hex(h: string): readonly [number, number, number] {
  const s = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255) as unknown as readonly [number, number, number];
}

export function solid(h: string): Colour {
  return { c: hex(h), a: 1 };
}

export function rgba(r: number, g: number, b: number, a = 1): Colour {
  return { c: [r / 255, g / 255, b / 255], a };
}

/** Source-over compositing of `top` onto an opaque `under`. */
export function over(top: Colour, under: Colour): Colour {
  return { c: top.c.map((v, i) => v * top.a + (under.c[i] ?? 0) * (1 - top.a)) as unknown as Colour['c'], a: 1 };
}

const lin = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const delin = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function toOklab(rgb: readonly number[]): [number, number, number] {
  const [r, g, b] = rgb.map(lin) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab(lab: readonly number[]): [number, number, number] {
  const [L, A, B] = lab as [number, number, number];
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, delin(v)))) as [number, number, number];
}

/** `color-mix(in oklab, a p, b)` for opaque inputs; `p` is a's share, 0..1. */
export function mix(a: Colour, b: Colour, p: number): Colour {
  const A = toOklab(a.c);
  const B = toOklab(b.c);
  return { c: fromOklab(A.map((v, i) => v * p + (B[i] ?? 0) * (1 - p)) as [number, number, number]), a: 1 };
}

function luminance({ c }: Colour): number {
  const [r, g, b] = c.map(lin) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two opaque colours. */
export function ratio(x: Colour, y: Colour): number {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** A translucent token flattened over the vibrancy stand-in for its appearance. */
export function flatten(x: Colour, dark: boolean): Colour {
  return x.a < 1 ? over(x, dark ? VIBRANCY_DARK : VIBRANCY_LIGHT) : x;
}

export interface ThemeColours {
  readonly dark: boolean;
  readonly bg: Colour;
  readonly panelStrong: Colour;
}

/** The opaque panel colour before alpha: `--panel-strong` lifted toward white. */
export function panelBase(theme: ThemeColours, p: ModalParams): Colour {
  return mix({ c: theme.panelStrong.c, a: 1 }, solid('#ffffff'), 1 - p.lift);
}

/** The scrim colour: flattened `--bg`, darkened in dark themes, at the scrim alpha. */
export function scrimColour(theme: ThemeColours, p: ModalParams): Colour {
  const bg = flatten(theme.bg, theme.dark);
  return { c: bg.c.map((v) => (theme.dark ? v * p.scrimDarken : v)) as unknown as Colour['c'], a: p.scrimAlpha };
}

/** What the eye sees behind panel text: panel over scrim over `under` (already flattened). */
export function modalSurface(theme: ThemeColours, p: ModalParams, under: Colour): Colour {
  const panel: Colour = { c: panelBase(theme, p).c, a: p.panelAlpha };
  return over(panel, over(scrimColour(theme, p), under));
}

/** Reduced transparency: the opaque panel over `under`. */
export function reducedSurface(theme: ThemeColours, p: ModalParams, under: Colour): Colour {
  return over(panelBase(theme, p), under);
}

/** The two composite bases the AC23 gate measures against. */
export function unders(theme: ThemeColours): { readonly bg: Colour; readonly panelStrong: Colour } {
  return { bg: flatten(theme.bg, theme.dark), panelStrong: flatten(theme.panelStrong, theme.dark) };
}
