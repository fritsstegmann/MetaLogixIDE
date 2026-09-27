/**
 * Main-process owner of the current window material. It applies native
 * window opacity per platform and hands new windows the current render values
 * through their URL query, so a window opened after a change never starts
 * from stale values. It depends on injected functions only, never `electron`.
 */
import {
  DEFAULT_WINDOW_MATERIAL,
  MATERIAL_QUERY_PARAM,
  nativeOpacityFor,
  serializeMaterialQuery,
  toRenderMaterial,
  type WindowMaterial,
} from '@shared/window-material';

/** The slice of BrowserWindow the controller needs; injected so it is unit-testable. */
export interface MaterialWindow {
  setOpacity(opacity: number): void;
  isDestroyed(): boolean;
}

/** Platform facts, window access and the seed material a controller is built from. */
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

/**
 * Build a controller seeded with `deps.initial`. On darwin native opacity is
 * never touched (surfaces carry the opacity in CSS); elsewhere every live
 * window gets `nativeOpacityFor` of the current material. Methods are closures,
 * so each can be passed on as a detached callback.
 */
export function createMaterialController(deps: MaterialControllerDeps): MaterialController {
  let material = deps.initial;
  const setNativeOpacity = (win: MaterialWindow): void => {
    if (deps.platform === 'darwin' || win.isDestroyed()) return;
    win.setOpacity(nativeOpacityFor(material, deps.platform, deps.getReducedTransparency()));
  };
  const applyToAll = (): void => { deps.listWindows().forEach(setNativeOpacity); };
  return {
    current: () => material,
    apply: (m) => { material = m; applyToAll(); },
    prepareNewWindow: setNativeOpacity,
    queryString: () => `${MATERIAL_QUERY_PARAM}=${encodeURIComponent(serializeMaterialQuery(toRenderMaterial(material, deps.platform)))}`,
    onReducedTransparencyChanged: applyToAll,
  };
}

/**
 * Seed material for boot: the result of `read`, or a copy of the defaults
 * when `read` throws, so a storage failure never blocks the first window.
 * The cause is passed to `onError`.
 */
export function readInitialMaterial(read: () => WindowMaterial, onError: (cause: unknown) => void): WindowMaterial {
  try {
    return read();
  } catch (cause) {
    onError(cause);
    return { ...DEFAULT_WINDOW_MATERIAL };
  }
}
