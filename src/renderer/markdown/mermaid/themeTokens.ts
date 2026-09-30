/**
 * DOM adapter that reads the app's theme tokens for the Mermaid palette. The
 * computed style already reflects `data-theme` and the System-mode media
 * query, so this reads whichever palette is live, with no theme logic of its
 * own. Values are returned raw (trimmed); parsing is the palette's job.
 */
import { THEME_TOKEN_NAMES, type ThemeTokens } from './paletteContract';

/** Reads every `THEME_TOKEN_NAMES` custom property from `root`'s computed style. */
export function readThemeTokens(root: Element = document.documentElement): ThemeTokens {
  const view = root.ownerDocument.defaultView ?? window;
  const style = view.getComputedStyle(root);
  const entries = Object.entries(THEME_TOKEN_NAMES).map(
    ([field, name]) => [field, style.getPropertyValue(name).trim()] as const,
  );
  return Object.fromEntries(entries) as unknown as ThemeTokens;
}
