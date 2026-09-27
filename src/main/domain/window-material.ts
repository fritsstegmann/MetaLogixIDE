/**
 * Window material persistence rules: read the three stored values with
 * clamping, and apply a patch atomically while reporting which setting keys
 * changed so the IPC layer can emit exactly one event per change.
 */
import type { SettingsRepo } from '@main/repos/settings-repo';
import type { SettingsMap } from '@shared/types';
import { normalizeWindowMaterial, WINDOW_MATERIAL_SETTING_KEYS, type WindowMaterial } from '@shared/window-material';

const FIELDS = Object.keys(WINDOW_MATERIAL_SETTING_KEYS) as Array<keyof WindowMaterial>;

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
  const changed = FIELDS.filter((field) => material[field] !== current[field]);
  const changedKeys = changed.map((field) => WINDOW_MATERIAL_SETTING_KEYS[field]);
  if (changed.length > 0) {
    settings.setMany(Object.fromEntries(changed.map((field) => [WINDOW_MATERIAL_SETTING_KEYS[field], material[field]])));
  }
  return { material, changedKeys };
}
