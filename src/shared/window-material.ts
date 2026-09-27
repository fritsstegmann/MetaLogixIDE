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

/** Inclusive valid range per field, in the field's unit (opacity %, blur px, saturation %). */
export const WINDOW_MATERIAL_RANGES: { readonly [K in keyof WindowMaterial]: { readonly min: number; readonly max: number } } = {
  opacity:    { min: 30,  max: 100 },
  blur:       { min: 0,   max: 40 },
  saturation: { min: 100, max: 200 },
};

/** Apple-like defaults: `saturate(180%) blur(20px)`, fully opaque surfaces. */
export const DEFAULT_WINDOW_MATERIAL: WindowMaterial = { opacity: 100, blur: 20, saturation: 180 };

/** The `SettingsMap` key each field is persisted under. */
export const WINDOW_MATERIAL_SETTING_KEYS = {
  opacity:    'window_opacity',
  blur:       'window_backdrop_blur',
  saturation: 'window_backdrop_saturation',
} as const;

/** Surfaces that carry the material backdrop, named by their `data-material-surface` attribute. */
export const MATERIAL_SURFACES = [
  'titlebar', 'popout-titlebar', 'statusbar', 'activitybar', 'sidebar',
  'section-panel', 'chat-header', 'context-menu', 'hover-preview', 'toast',
] as const;
export type MaterialSurface = typeof MATERIAL_SURFACES[number];

/** URL query parameter that carries a new window's render values. */
export const MATERIAL_QUERY_PARAM = 'material';

const MATERIAL_FIELDS = Object.keys(WINDOW_MATERIAL_RANGES) as Array<keyof WindowMaterial>;
const QUERY_PART = /^\d+(\.\d+)?$/;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function clampField(field: keyof WindowMaterial, value: number): number {
  const { min, max } = WINDOW_MATERIAL_RANGES[field];
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Round then clamp each known field. Non-number or non-finite fields are
 * treated as absent and take the value from `fallback`. Unknown fields,
 * inherited fields and a non-object `raw` are ignored.
 */
export function normalizeWindowMaterial(
  raw: Partial<Record<keyof WindowMaterial, unknown>>,
  fallback: WindowMaterial = DEFAULT_WINDOW_MATERIAL,
): WindowMaterial {
  const source: object = typeof raw === 'object' && raw !== null ? raw : {};
  const pick = (field: keyof WindowMaterial): number => {
    const v: unknown = Object.hasOwn(source, field) ? (source as Record<string, unknown>)[field] : undefined;
    return clampField(field, isFiniteNumber(v) ? v : fallback[field]);
  };
  return { opacity: pick('opacity'), blur: pick('blur'), saturation: pick('saturation') };
}

/** Setting keys of the fields that differ between `before` and `after`, in field order. */
export function changedMaterialKeys(
  before: WindowMaterial,
  after: WindowMaterial,
): Array<typeof WINDOW_MATERIAL_SETTING_KEYS[keyof WindowMaterial]> {
  return MATERIAL_FIELDS.filter((field) => before[field] !== after[field]).map((field) => WINDOW_MATERIAL_SETTING_KEYS[field]);
}

/** darwin: surfaceAlpha = opacity / 100. Other platforms: surfaceAlpha = 1. */
export function toRenderMaterial(m: WindowMaterial, platform: string): WindowMaterialRender {
  return {
    surfaceAlpha: platform === 'darwin' ? m.opacity / 100 : 1,
    blurPx: m.blur,
    saturatePct: m.saturation,
  };
}

/** darwin → 1; reduced transparency → 1; otherwise opacity / 100. */
export function nativeOpacityFor(m: WindowMaterial, platform: string, reducedTransparency: boolean): number {
  if (platform === 'darwin' || reducedTransparency) return 1;
  return m.opacity / 100;
}

/** Value of the `material` query parameter for a new window's URL: `<alpha>,<blurPx>,<saturatePct>`. */
export function serializeMaterialQuery(r: WindowMaterialRender): string {
  return `${r.surfaceAlpha},${r.blurPx},${r.saturatePct}`;
}

function inRenderRange(r: WindowMaterialRender): boolean {
  const { opacity, blur, saturation } = WINDOW_MATERIAL_RANGES;
  return r.surfaceAlpha >= opacity.min / 100 && r.surfaceAlpha <= opacity.max / 100
    && Number.isInteger(r.blurPx) && r.blurPx >= blur.min && r.blurPx <= blur.max
    && Number.isInteger(r.saturatePct) && r.saturatePct >= saturation.min && r.saturatePct <= saturation.max;
}

/** Parse a `location.search` string; `null` on missing, malformed or out-of-range input. */
export function parseMaterialQuery(search: string): WindowMaterialRender | null {
  const parts = new URLSearchParams(search).get(MATERIAL_QUERY_PARAM)?.split(',') ?? [];
  if (parts.length !== MATERIAL_FIELDS.length || !parts.every((p) => QUERY_PART.test(p))) return null;
  const [surfaceAlpha, blurPx, saturatePct] = parts.map(Number) as [number, number, number];
  const render = { surfaceAlpha, blurPx, saturatePct };
  return inRenderRange(render) ? render : null;
}
