import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WINDOW_MATERIAL,
  MATERIAL_QUERY_PARAM,
  WINDOW_MATERIAL_RANGES,
  WINDOW_MATERIAL_SETTING_KEYS,
  changedMaterialKeys,
  nativeOpacityFor,
  normalizeWindowMaterial,
  parseMaterialQuery,
  serializeMaterialQuery,
  toRenderMaterial,
  type WindowMaterial,
} from '@shared/window-material';

const CUSTOM: WindowMaterial = { opacity: 70, blur: 12, saturation: 150 };

describe('window material contract (AC1)', () => {
  it('ranges are opacity 30..100, blur 0..40, saturation 100..200', () => {
    expect(WINDOW_MATERIAL_RANGES).toEqual({
      opacity: { min: 30, max: 100 },
      blur: { min: 0, max: 40 },
      saturation: { min: 100, max: 200 },
    });
  });

  it('defaults are opacity 100, blur 20, saturation 180', () => {
    expect(DEFAULT_WINDOW_MATERIAL).toEqual({ opacity: 100, blur: 20, saturation: 180 });
  });

  it('keeps the existing window_opacity key and adds the two backdrop keys', () => {
    expect(WINDOW_MATERIAL_SETTING_KEYS).toEqual({
      opacity: 'window_opacity',
      blur: 'window_backdrop_blur',
      saturation: 'window_backdrop_saturation',
    });
  });
});

describe('normalizeWindowMaterial', () => {
  it.each([
    ['opacity', 29, 30], ['opacity', 101, 100], ['opacity', 30, 30], ['opacity', 100, 100],
    ['blur', -1, 0], ['blur', 41, 40], ['blur', 55, 40], ['blur', 0, 0], ['blur', 40, 40],
    ['saturation', 99, 100], ['saturation', 90, 100], ['saturation', 201, 200], ['saturation', 100, 100], ['saturation', 200, 200],
  ] as const)('clamps %s %d to %d', (field, input, expected) => {
    expect(normalizeWindowMaterial({ [field]: input })[field]).toBe(expected);
  });

  it('rounds to the nearest whole value (12.6 → 13, 12.4 → 12)', () => {
    expect(normalizeWindowMaterial({ blur: 12.6 }).blur).toBe(13);
    expect(normalizeWindowMaterial({ blur: 12.4 }).blur).toBe(12);
    expect(normalizeWindowMaterial({ opacity: 70.5 }).opacity).toBe(71);
  });

  it('rounds before clamping, so 29.6 opacity becomes 30 and 40.4 blur becomes 40', () => {
    expect(normalizeWindowMaterial({ opacity: 29.6 }).opacity).toBe(30);
    expect(normalizeWindowMaterial({ blur: 40.4 }).blur).toBe(40);
  });

  it('takes absent fields from the fallback', () => {
    expect(normalizeWindowMaterial({ blur: 5 }, CUSTOM)).toEqual({ opacity: 70, blur: 5, saturation: 150 });
  });

  it('defaults the fallback to DEFAULT_WINDOW_MATERIAL', () => {
    expect(normalizeWindowMaterial({})).toEqual(DEFAULT_WINDOW_MATERIAL);
  });

  it('drops unknown fields', () => {
    const out = normalizeWindowMaterial({ blur: 5, extra: 1, __proto__: { opacity: 31 } } as unknown as Partial<Record<keyof WindowMaterial, unknown>>, CUSTOM);
    expect(out).toEqual({ opacity: 70, blur: 5, saturation: 150 });
    expect(Object.keys(out).sort()).toEqual(['blur', 'opacity', 'saturation']);
  });

  it.each([
    ['a numeric string', '35'],
    ['a string', 'x'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['null', null],
    ['an object', { valueOf: () => 35 }],
    ['an array', [35]],
    ['a boolean', true],
  ])('ignores %s and keeps the fallback', (_label, bad) => {
    const raw = { opacity: bad, blur: bad, saturation: bad };
    expect(normalizeWindowMaterial(raw, CUSTOM)).toEqual(CUSTOM);
  });

  it.each([null, undefined, 'x', 42])('treats a non-object input %j as an empty patch', (raw) => {
    expect(normalizeWindowMaterial(raw as unknown as Partial<Record<keyof WindowMaterial, unknown>>, CUSTOM)).toEqual(CUSTOM);
  });

  it('does not mutate its inputs', () => {
    const raw = { blur: 99 };
    const fallback = { ...CUSTOM };
    normalizeWindowMaterial(raw, fallback);
    expect(raw).toEqual({ blur: 99 });
    expect(fallback).toEqual(CUSTOM);
  });
});

describe('toRenderMaterial', () => {
  it('on darwin scales surface alpha with opacity', () => {
    expect(toRenderMaterial(CUSTOM, 'darwin')).toEqual({ surfaceAlpha: 0.7, blurPx: 12, saturatePct: 150 });
    expect(toRenderMaterial({ ...CUSTOM, opacity: 30 }, 'darwin').surfaceAlpha).toBe(0.3);
    expect(toRenderMaterial({ ...CUSTOM, opacity: 100 }, 'darwin').surfaceAlpha).toBe(1);
  });

  it.each(['win32', 'linux'])('on %s keeps surfaces opaque (alpha 1)', (platform) => {
    expect(toRenderMaterial(CUSTOM, platform)).toEqual({ surfaceAlpha: 1, blurPx: 12, saturatePct: 150 });
  });
});

describe('nativeOpacityFor', () => {
  it.each([30, 70, 100])('is 1 on darwin at opacity %d', (opacity) => {
    expect(nativeOpacityFor({ ...CUSTOM, opacity }, 'darwin', false)).toBe(1);
  });

  it.each(['win32', 'linux'])('is opacity / 100 on %s', (platform) => {
    expect(nativeOpacityFor(CUSTOM, platform, false)).toBe(0.7);
    expect(nativeOpacityFor({ ...CUSTOM, opacity: 30 }, platform, false)).toBe(0.3);
  });

  it.each(['win32', 'linux', 'darwin'])('is 1 on %s under reduced transparency', (platform) => {
    expect(nativeOpacityFor(CUSTOM, platform, true)).toBe(1);
  });
});

describe('material query', () => {
  it('round-trips render values through a location.search string', () => {
    const r = { surfaceAlpha: 0.7, blurPx: 12, saturatePct: 150 };
    const search = `?popout=1&${MATERIAL_QUERY_PARAM}=${encodeURIComponent(serializeMaterialQuery(r))}&projectId=3`;
    expect(parseMaterialQuery(search)).toEqual(r);
  });

  it('round-trips an unencoded parameter value', () => {
    const r = { surfaceAlpha: 0.3, blurPx: 0, saturatePct: 200 };
    expect(parseMaterialQuery(`?${MATERIAL_QUERY_PARAM}=${serializeMaterialQuery(r)}`)).toEqual(r);
  });

  it('round-trips every render value derived from the range bounds', () => {
    for (const platform of ['darwin', 'linux']) {
      for (const m of [DEFAULT_WINDOW_MATERIAL, { opacity: 30, blur: 0, saturation: 100 }, { opacity: 100, blur: 40, saturation: 200 }]) {
        const r = toRenderMaterial(m, platform);
        expect(parseMaterialQuery(`?${MATERIAL_QUERY_PARAM}=${serializeMaterialQuery(r)}`)).toEqual(r);
      }
    }
  });

  it.each([
    ['empty search', ''],
    ['missing parameter', '?popout=1&projectId=3'],
    ['empty value', '?material='],
    ['too few parts', '?material=0.7,12'],
    ['too many parts', '?material=0.7,12,150,1'],
    ['empty part', '?material=0.7,,150'],
    ['non-numeric part', '?material=0.7,abc,150'],
    ['NaN part', '?material=NaN,12,150'],
    ['Infinity part', '?material=0.7,Infinity,150'],
    ['hex part', '?material=0.7,0x10,150'],
    ['exponent part', '?material=0.7,1e1,150'],
    ['negative blur', '?material=0.7,-1,150'],
    ['alpha below range', '?material=0.29,12,150'],
    ['alpha above range', '?material=1.01,12,150'],
    ['blur above range', '?material=0.7,41,150'],
    ['saturation below range', '?material=0.7,12,99'],
    ['saturation above range', '?material=0.7,12,201'],
    ['fractional blur', '?material=0.7,12.5,150'],
    ['fractional saturation', '?material=0.7,12,150.5'],
    ['whitespace padded', '?material=%200.7,12,150'],
  ])('returns null for %s', (_label, search) => {
    expect(parseMaterialQuery(search)).toBeNull();
  });
});

describe('changedMaterialKeys', () => {
  it('is empty for equal materials', () => {
    expect(changedMaterialKeys(CUSTOM, { ...CUSTOM })).toEqual([]);
  });

  it.each([
    ['opacity', 'window_opacity'],
    ['blur', 'window_backdrop_blur'],
    ['saturation', 'window_backdrop_saturation'],
  ] as const)('reports only the setting key of a changed %s', (field, key) => {
    expect(changedMaterialKeys(CUSTOM, { ...CUSTOM, [field]: CUSTOM[field] + 1 })).toEqual([key]);
  });

  it('reports every changed key once, in field order', () => {
    expect(changedMaterialKeys(CUSTOM, DEFAULT_WINDOW_MATERIAL)).toEqual(['window_opacity', 'window_backdrop_blur', 'window_backdrop_saturation']);
  });
});
