/**
 * The renderer's shortcut platform, resolved once and synchronously at module load from the
 * preload bridge (`window.api.platform`), so the first React render already carries the right
 * labels. Components read it through `useShortcutPlatform()`; tests inject a value through
 * `ShortcutPlatformContext.Provider` or by passing `platform` to the pure builders.
 *
 * Never import `./api` here: it dereferences `window.api` at import and throws under node tests.
 */
import { createContext, useContext } from 'react';
import type { ShortcutPlatform } from './shortcut-contract';

/** `darwin` → mac; any other defined value → other; undefined (node tests, no bridge) → mac. */
export function toShortcutPlatform(nodePlatform: string | undefined): ShortcutPlatform {
  if (nodePlatform === undefined) return 'mac';
  return nodePlatform === 'darwin' ? 'mac' : 'other';
}

interface PlatformBridge { readonly api?: { readonly platform?: string } }

export const RUNTIME_SHORTCUT_PLATFORM: ShortcutPlatform = toShortcutPlatform(
  (globalThis as { window?: PlatformBridge }).window?.api?.platform,
);

export const ShortcutPlatformContext = createContext<ShortcutPlatform>(RUNTIME_SHORTCUT_PLATFORM);

export function useShortcutPlatform(): ShortcutPlatform {
  return useContext(ShortcutPlatformContext);
}
