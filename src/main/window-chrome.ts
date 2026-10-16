import type { BrowserWindowConstructorOptions } from 'electron';
import { FROST_TERMINAL_QUERY_KEY } from '@shared/frost-terminal';

/**
 * Per-platform BrowserWindow chrome options shared by the main and popout windows. On darwin
 * the material goes flat when the window is inactive (`visualEffectState: 'followWindow'`,
 * AC18); every other darwin option is the existing baseline. Non-darwin is unchanged (AC26).
 */
export function platformChrome(platform: NodeJS.Platform): Partial<BrowserWindowConstructorOptions> {
  return platform === 'darwin'
    ? {
        titleBarStyle: 'hiddenInset',
        // y centres the lights on the 44px title bar shared by the main and popout windows.
        trafficLightPosition: { x: 12, y: 14 },
        vibrancy: 'sidebar',
        visualEffectState: 'followWindow',
        roundedCorners: true,
      }
    // Windows/Linux draw the app menu as an in-window bar above our own title
    // bar. Hide it until Alt is pressed; its accelerators keep working.
    : { autoHideMenuBar: true };
}

export interface RendererQueryInput {
  popout?: { projectId: number; shellIndex: number };
  frostTerminal: boolean;
  platform: NodeJS.Platform;
}

/**
 * Query string (without the leading `?`) the renderer reads at first paint. `frostTerminal` is
 * sent as `1` only when the platform is darwin and the stored setting is true; every other
 * platform always sends `0`, so a stored ON value has no effect off macOS (AC13). Popout
 * parameters, when present, come first and are otherwise unchanged (AC7).
 */
export function rendererQuery(input: RendererQueryInput): string {
  const parts: string[] = [];
  if (input.popout) parts.push(`popout=1&projectId=${input.popout.projectId}&shellIndex=${input.popout.shellIndex}`);
  const frost = input.platform === 'darwin' && input.frostTerminal ? '1' : '0';
  parts.push(`${FROST_TERMINAL_QUERY_KEY}=${frost}`);
  return parts.join('&');
}
