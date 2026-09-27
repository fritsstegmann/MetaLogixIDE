/**
 * Window material persistence rules: read the three stored values with
 * clamping, and apply a patch atomically while reporting which setting keys
 * changed so the IPC layer can emit exactly one event per change.
 */
import type { SettingsRepo } from '@main/repos/settings-repo';
import type { SettingsMap } from '@shared/types';
import { changedMaterialKeys, normalizeWindowMaterial, WINDOW_MATERIAL_SETTING_KEYS, type WindowMaterial } from '@shared/window-material';

const FIELD_BY_KEY = Object.fromEntries(
  Object.entries(WINDOW_MATERIAL_SETTING_KEYS).map(([field, key]) => [key, field as keyof WindowMaterial]),
) as Record<typeof WINDOW_MATERIAL_SETTING_KEYS[keyof WindowMaterial], keyof WindowMaterial>;

/** Read the stored window material, clamping any out-of-range stored value. */
export function readWindowMaterial(settings: SettingsRepo): WindowMaterial {
  return normalizeWindowMaterial({
    opacity: settings.get(WINDOW_MATERIAL_SETTING_KEYS.opacity),
    blur: settings.get(WINDOW_MATERIAL_SETTING_KEYS.blur),
    saturation: settings.get(WINDOW_MATERIAL_SETTING_KEYS.saturation),
  });
}

/**
 * Normalise `patch` over the stored material, persist the changed values in
 * one `setMany` transaction (nothing is written when nothing changed), and
 * report which setting keys changed relative to the clamped stored values.
 */
export function applyWindowMaterial(
  settings: SettingsRepo,
  patch: Partial<Record<keyof WindowMaterial, unknown>>,
): { material: WindowMaterial; changedKeys: Array<keyof SettingsMap> } {
  const current = readWindowMaterial(settings);
  const material = normalizeWindowMaterial(patch, current);
  const changedKeys = changedMaterialKeys(current, material);
  if (changedKeys.length > 0) {
    settings.setMany(Object.fromEntries(changedKeys.map((key) => [key, material[FIELD_BY_KEY[key]]])));
  }
  return { material, changedKeys };
}
