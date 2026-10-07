import { useLayoutEffect } from 'react';
import { holdTerminalGeometry } from '@renderer/terminal-geometry-hold';

/**
 * Holds every terminal's geometry while `active` is true. The hold is taken and released in layout
 * effects, so it is in place before the browser delivers ResizeObserver callbacks for the commit
 * that started a fold, and a release runs its single refit against the commit that ended it.
 */
export function useTerminalGeometryHold(active: boolean): void {
  useLayoutEffect(() => (active ? holdTerminalGeometry() : undefined), [active]);
}
