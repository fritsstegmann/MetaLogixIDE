import type { WindowMaterialRender } from '@shared/window-material';

/** Minimal style target (document.documentElement in the app). */
export interface StyleTarget { style: { setProperty(name: string, value: string): void } }

/** Set --material-alpha / --material-blur / --material-saturate from numbers. */
export function applyRenderToRoot(_target: StyleTarget, _render: WindowMaterialRender): void {
  throw new Error('not implemented');
}

/** Apply the `material` query values, if valid, before first render. */
export function bootstrapFromQuery(_target: StyleTarget, _search: string): void {
  throw new Error('not implemented');
}
