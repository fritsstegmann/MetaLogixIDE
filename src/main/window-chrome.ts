import type { BrowserWindowConstructorOptions } from 'electron';
import {
  FROSTED_GLASS_DEFAULTS,
  FROSTED_GLASS_QUERY_KEYS,
  isVibrancyMaterial,
  type ChromeFrostLevel,
  type TerminalFrostLevel,
  type VibrancyMaterial,
} from '@shared/frosted-glass';

/** Resolves an untrusted stored or renderer-supplied value to an approved vibrancy material, falling back to `'sidebar'` for anything outside the allow-list (AC18). */
export function resolveMaterial(material: unknown): VibrancyMaterial {
  return isVibrancyMaterial(material) ? material : 'sidebar';
}

/**
 * Per-platform BrowserWindow chrome options shared by the main and popout windows. On darwin
 * the material goes flat when the window is inactive (`visualEffectState: 'followWindow'`,
 * AC18); the vibrancy is the resolved material; every other darwin option is the existing
 * baseline. Non-darwin is unchanged and never carries a material (AC20, AC26).
 */
export function platformChrome(platform: NodeJS.Platform, material: unknown): Partial<BrowserWindowConstructorOptions> {
  return platform === 'darwin'
    ? {
        titleBarStyle: 'hiddenInset',
        // y centres the lights on the 44px title bar shared by the main and popout windows.
        trafficLightPosition: { x: 12, y: 14 },
        vibrancy: resolveMaterial(material),
        visualEffectState: 'followWindow',
        roundedCorners: true,
      }
    // Windows/Linux draw the app menu as an in-window bar above our own title
    // bar. Hide it until Alt is pressed; its accelerators keep working.
    : { autoHideMenuBar: true };
}

export interface VibrancyTarget {
  isDestroyed(): boolean;
  setVibrancy(material: VibrancyMaterial): void;
}

/**
 * Applies the resolved material to every non-destroyed window (AC19); a no-op off darwin
 * (AC20). Pure over `{ isDestroyed(), setVibrancy() }` so it is unit-testable without a real
 * `BrowserWindow` (D6).
 */
export function applyVibrancy(windows: readonly VibrancyTarget[], material: unknown, platform: NodeJS.Platform): void {
  if (platform !== 'darwin') return;
  const resolved = resolveMaterial(material);
  for (const w of windows) {
    if (!w.isDestroyed()) w.setVibrancy(resolved);
  }
}

export interface RendererQueryInput {
  popout?: { projectId: number; shellIndex: number };
  platform: NodeJS.Platform;
  frostChrome: boolean;
  chromeFrost: ChromeFrostLevel;
  terminalFrost: TerminalFrostLevel;
}

/**
 * Query string (without the leading `?`) the renderer reads at first paint. Off darwin, the
 * frosted-glass flags always resolve to the no-effect defaults, so a stored ON value or level
 * has no effect off macOS (AC6). Popout parameters, when present, come first (AC7).
 */
export function rendererQuery(input: RendererQueryInput): string {
  const parts: string[] = [];
  if (input.popout) parts.push(`popout=1&projectId=${input.popout.projectId}&shellIndex=${input.popout.shellIndex}`);
  const mac = input.platform === 'darwin';
  // Off darwin no mac flag is ever applied regardless of the value sent, so the no-effect
  // default for frostChrome is `false` here — not FROSTED_GLASS_DEFAULTS.frostChrome (`true`,
  // the stored default), which would misleadingly claim the flag is on (AC6).
  const frostChrome = mac ? input.frostChrome : false;
  const chromeFrost = mac ? input.chromeFrost : FROSTED_GLASS_DEFAULTS.chromeFrostLevel;
  const terminalFrost = mac ? input.terminalFrost : FROSTED_GLASS_DEFAULTS.terminalFrostLevel;
  parts.push(`${FROSTED_GLASS_QUERY_KEYS.frostChrome}=${frostChrome ? '1' : '0'}`);
  parts.push(`${FROSTED_GLASS_QUERY_KEYS.chromeFrost}=${chromeFrost}`);
  parts.push(`${FROSTED_GLASS_QUERY_KEYS.terminalFrost}=${terminalFrost}`);
  return parts.join('&');
}
