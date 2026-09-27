import type { SettingsRepo } from '@main/repos/settings-repo';
import type { SettingsMap } from '@shared/types';
import type { WindowMaterial } from '@shared/window-material';

/** Read the stored window material, clamping any out-of-range stored value. */
export function readWindowMaterial(_settings: SettingsRepo): WindowMaterial {
  throw new Error('not implemented');
}

/**
 * Normalise `patch` over the stored material, persist it atomically, and
 * report which setting keys actually changed.
 */
export function applyWindowMaterial(
  _settings: SettingsRepo,
  _patch: Partial<Record<keyof WindowMaterial, unknown>>,
): { material: WindowMaterial; changedKeys: Array<keyof SettingsMap> } {
  throw new Error('not implemented');
}
