import { describe, it, expect, vi } from 'vitest';
import { applyWindowMaterial, readWindowMaterial } from '@main/domain/window-material';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { SettingsRepo } from '@main/repos/settings-repo';
import type { SettingsMap } from '@shared/types';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const migrationsDir = resolve(__dirname, '../../../../migrations');

/** Real SettingsRepo backed by a temp sqlite db, seeded with defaults. */
function realSettings(): SettingsRepo {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wm-')), 'db'));
  runMigrations(db, migrationsDir);
  const repo = new SettingsRepo(db);
  repo.seedDefaults();
  return repo;
}

function stored(settings: SettingsRepo) {
  return {
    opacity: settings.get('window_opacity'),
    blur: settings.get('window_backdrop_blur'),
    saturation: settings.get('window_backdrop_saturation'),
  };
}

describe('readWindowMaterial', () => {
  it('reads the seeded defaults', () => {
    expect(readWindowMaterial(realSettings())).toEqual({ opacity: 100, blur: 20, saturation: 180 });
  });

  it('reads stored in-range values unchanged', () => {
    const settings = realSettings();
    settings.setMany({ window_opacity: 45, window_backdrop_blur: 7, window_backdrop_saturation: 133 });
    expect(readWindowMaterial(settings)).toEqual({ opacity: 45, blur: 7, saturation: 133 });
  });

  it('clamps and rounds out-of-range stored values (AC3, storage)', () => {
    const settings = realSettings();
    settings.setMany({ window_opacity: 10, window_backdrop_blur: 55, window_backdrop_saturation: 90 });
    expect(readWindowMaterial(settings)).toEqual({ opacity: 30, blur: 40, saturation: 100 });
    settings.setMany({ window_opacity: 101, window_backdrop_blur: 12.6, window_backdrop_saturation: 201 });
    expect(readWindowMaterial(settings)).toEqual({ opacity: 100, blur: 13, saturation: 200 });
  });

  it('falls back to the default for a stored non-number', () => {
    const settings = realSettings();
    settings.set('window_backdrop_blur', 'x' as unknown as number);
    settings.set('window_opacity', null as unknown as number);
    expect(readWindowMaterial(settings)).toEqual({ opacity: 100, blur: 20, saturation: 180 });
  });

  it('does not write to storage', () => {
    const settings = realSettings();
    settings.set('window_backdrop_blur', 55);
    const setMany = vi.spyOn(settings, 'setMany');
    const set = vi.spyOn(settings, 'set');
    readWindowMaterial(settings);
    expect(setMany).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(settings.get('window_backdrop_blur')).toBe(55);
  });
});

describe('applyWindowMaterial', () => {
  it('persists the normalised patch and returns the full material', () => {
    const settings = realSettings();
    const result = applyWindowMaterial(settings, { blur: 55, saturation: 150.4 });
    expect(result.material).toEqual({ opacity: 100, blur: 40, saturation: 150 });
    expect(stored(settings)).toEqual({ opacity: 100, blur: 40, saturation: 150 });
  });

  it('writes through one setMany call (atomic), never per-key set', () => {
    const settings = realSettings();
    const setMany = vi.spyOn(settings, 'setMany');
    const set = vi.spyOn(settings, 'set');
    applyWindowMaterial(settings, { opacity: 60, blur: 5 });
    expect(setMany).toHaveBeenCalledTimes(1);
    expect(setMany).toHaveBeenCalledWith({ window_opacity: 60, window_backdrop_blur: 5 });
    expect(set).not.toHaveBeenCalled();
  });

  it('reports only the keys that actually changed', () => {
    const settings = realSettings();
    const result = applyWindowMaterial(settings, { opacity: 100, blur: 21, saturation: 180 });
    expect(result.changedKeys).toEqual<Array<keyof SettingsMap>>(['window_backdrop_blur']);
  });

  it('a patch equal to storage changes nothing and writes nothing', () => {
    const settings = realSettings();
    const setMany = vi.spyOn(settings, 'setMany');
    const result = applyWindowMaterial(settings, { opacity: 100, blur: 20, saturation: 180 });
    expect(result.changedKeys).toEqual([]);
    expect(setMany).not.toHaveBeenCalled();
  });

  it('keeps current values for invalid and unknown fields', () => {
    const settings = realSettings();
    settings.setMany({ window_opacity: 70, window_backdrop_blur: 10, window_backdrop_saturation: 150 });
    const result = applyWindowMaterial(settings, { blur: 'x', saturation: Number.NaN, extra: 1 } as unknown as Parameters<typeof applyWindowMaterial>[1]);
    expect(result).toEqual({ material: { opacity: 70, blur: 10, saturation: 150 }, changedKeys: [] });
    expect(stored(settings)).toEqual({ opacity: 70, blur: 10, saturation: 150 });
  });

  it('a reset patch persists all three defaults (AC6)', () => {
    const settings = realSettings();
    settings.setMany({ window_opacity: 45, window_backdrop_blur: 3, window_backdrop_saturation: 120 });
    const result = applyWindowMaterial(settings, { opacity: 100, blur: 20, saturation: 180 });
    expect(result.material).toEqual({ opacity: 100, blur: 20, saturation: 180 });
    expect(new Set(result.changedKeys)).toEqual(new Set(['window_opacity', 'window_backdrop_blur', 'window_backdrop_saturation']));
    expect(result.changedKeys).toHaveLength(3);
    expect(stored(settings)).toEqual({ opacity: 100, blur: 20, saturation: 180 });
  });

  it('compares against the clamped stored value, so a patch equal to it reports no change', () => {
    const settings = realSettings();
    settings.set('window_backdrop_blur', 55);
    const result = applyWindowMaterial(settings, { blur: 40 });
    expect(result.changedKeys).toEqual([]);
    expect(result.material.blur).toBe(40);
  });

  it('writes nothing when setMany throws, and propagates the error', () => {
    const settings = realSettings();
    vi.spyOn(settings, 'setMany').mockImplementation(() => { throw new Error('disk full'); });
    expect(() => applyWindowMaterial(settings, { blur: 5 })).toThrow('disk full');
    expect(settings.get('window_backdrop_blur')).toBe(20);
  });
});
