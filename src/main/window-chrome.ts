import type { BrowserWindowConstructorOptions } from 'electron';

/** Per-platform BrowserWindow chrome options shared by the main and popout windows. */
export function platformChrome(platform: NodeJS.Platform): Partial<BrowserWindowConstructorOptions> {
  void platform;
  throw new Error('not implemented');
}

export interface RendererQueryInput {
  popout?: { projectId: number; shellIndex: number };
  frostTerminal: boolean;
  platform: NodeJS.Platform;
}

/** Query string (without the leading `?`) the renderer reads at first paint. */
export function rendererQuery(input: RendererQueryInput): string {
  void input;
  throw new Error('not implemented');
}
