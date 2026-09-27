import type { WindowMaterial } from '@shared/window-material';

/** The slice of BrowserWindow the controller needs; injected so it is unit-testable. */
export interface MaterialWindow {
  setOpacity(opacity: number): void;
  isDestroyed(): boolean;
}

export interface MaterialControllerDeps {
  platform: string;
  getReducedTransparency: () => boolean;
  listWindows: () => MaterialWindow[];
  initial: WindowMaterial;
}

/** Holds the current window material in the main process and applies it to windows. */
export interface MaterialController {
  current(): WindowMaterial;
  apply(m: WindowMaterial): void;
  prepareNewWindow(win: MaterialWindow): void;
  /** `material=<…>` query fragment for a new window's URL. */
  queryString(): string;
  onReducedTransparencyChanged(): void;
}

export function createMaterialController(_deps: MaterialControllerDeps): MaterialController {
  throw new Error('not implemented');
}
