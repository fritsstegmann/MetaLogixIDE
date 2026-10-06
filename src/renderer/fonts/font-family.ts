/**
 * Builds CSS font-family values from validated literal preferences and exact fallback stacks.
 */

import {
  parseFontFamilyPreference,
  type FontFamilyPreference,
} from '@shared/font-settings';

/** Serializes one validated family as a safely escaped, double-quoted CSS string. */
export function serializeFontFamily(family: string): string {
  const parsed = parseFontFamilyPreference(family);
  if (!parsed.ok || parsed.value === null) {
    throw new TypeError(parsed.ok ? 'font family cannot be null' : parsed.error);
  }
  return `"${parsed.value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** Prepends a selected literal family or returns the compatibility fallback unchanged. */
export function buildFontFamilyStack(
  family: FontFamilyPreference,
  fallback: string,
): string {
  return family === null ? fallback : `${serializeFontFamily(family)}, ${fallback}`;
}
