import type { ChromeFrostLevel, TerminalFrostLevel, VibrancyMaterial } from '@shared/frosted-glass';

export interface FrostedGlassSettings {
  frostChrome: boolean;
  chromeFrostLevel: ChromeFrostLevel;
  terminalFrostLevel: TerminalFrostLevel;
  vibrancyMaterial: VibrancyMaterial;
}

export interface FrostedGlassSettingsApi {
  values: FrostedGlassSettings;
  setFrostChrome: (enabled: boolean) => Promise<void>;
  setChromeFrostLevel: (level: ChromeFrostLevel) => Promise<void>;
  setTerminalFrostLevel: (level: TerminalFrostLevel) => Promise<void>;
  setVibrancyMaterial: (material: VibrancyMaterial) => Promise<void>;
}

/** Loads the four frosted-glass settings and saves each through its validated channel, reverting on failure. */
export function useFrostedGlassSettings(): FrostedGlassSettingsApi {
  throw new Error('not implemented');
}
