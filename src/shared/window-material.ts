/**
 * Window material: the three app-wide appearance values (opacity, backdrop
 * blur, backdrop saturation) and the pure rules both processes share.
 *
 * Blur and saturation drive a CSS `backdrop-filter` on the app's own
 * translucent surfaces. The desktop seen through the window is blurred by
 * the macOS vibrancy material, which Electron exposes no control over.
 */

/** Stored values: opacity in %, blur in px, saturation in %. */
export interface WindowMaterial { opacity: number; blur: number; saturation: number }

/** Values a renderer applies as CSS variables. */
export interface WindowMaterialRender { surfaceAlpha: number; blurPx: number; saturatePct: number }

export const WINDOW_MATERIAL_RANGES: { readonly [K in keyof WindowMaterial]: { readonly min: number; readonly max: number } } = {
  opacity:    { min: 30,  max: 100 },
  blur:       { min: 0,   max: 40 },
  saturation: { min: 100, max: 200 },
};

/** Apple-like defaults: `saturate(180%) blur(20px)`, fully opaque surfaces. */
export const DEFAULT_WINDOW_MATERIAL: WindowMaterial = { opacity: 100, blur: 20, saturation: 180 };

export const WINDOW_MATERIAL_SETTING_KEYS = {
  opacity:    'window_opacity',
  blur:       'window_backdrop_blur',
  saturation: 'window_backdrop_saturation',
} as const;

export const WINDOW_MATERIAL_CLASS = 'window-material';

export const MATERIAL_SURFACES = [
  'titlebar', 'popout-titlebar', 'statusbar', 'activitybar', 'sidebar',
  'section-panel', 'chat-header', 'context-menu', 'hover-preview', 'toast',
] as const;
export type MaterialSurface = typeof MATERIAL_SURFACES[number];

export const MATERIAL_QUERY_PARAM = 'material';

/**
 * Round then clamp each known field. Non-number or non-finite fields are
 * treated as absent and take the value from `fallback`. Unknown fields are
 * dropped.
 */
export function normalizeWindowMaterial(
  _raw: Partial<Record<keyof WindowMaterial, unknown>>,
  _fallback: WindowMaterial = DEFAULT_WINDOW_MATERIAL,
): WindowMaterial {
  throw new Error('not implemented');
}

/** darwin: surfaceAlpha = opacity / 100. Other platforms: surfaceAlpha = 1. */
export function toRenderMaterial(_m: WindowMaterial, _platform: string): WindowMaterialRender {
  throw new Error('not implemented');
}

/** darwin → 1; reduced transparency → 1; otherwise opacity / 100. */
export function nativeOpacityFor(_m: WindowMaterial, _platform: string, _reducedTransparency: boolean): number {
  throw new Error('not implemented');
}

/** Value of the `material` query parameter for a new window's URL. */
export function serializeMaterialQuery(_r: WindowMaterialRender): string {
  throw new Error('not implemented');
}

/** Parse a `location.search` string; `null` on missing, malformed or out-of-range input. */
export function parseMaterialQuery(_search: string): WindowMaterialRender | null {
  throw new Error('not implemented');
}
