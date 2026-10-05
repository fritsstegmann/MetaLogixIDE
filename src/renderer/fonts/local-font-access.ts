/**
 * Renderer-only adapter for Chromium Local Font Access that retains family metadata only.
 */
import { parseFontFamilyPreference } from '@shared/font-settings';

interface LocalFontAccessHost {
  readonly queryLocalFonts: () => Promise<unknown>;
}

export type LocalFontAccessResult =
  | { readonly status: 'unsupported' }
  | { readonly status: 'success'; readonly families: readonly string[] }
  | { readonly status: 'denied' }
  | { readonly status: 'error' };

function supportsLocalFontAccess(value: unknown): value is LocalFontAccessHost {
  return typeof value === 'object'
    && value !== null
    && 'queryLocalFonts' in value
    && typeof value.queryLocalFonts === 'function';
}

function familyFromMetadata(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('family' in value)) return null;
  const parsed = parseFontFamilyPreference(value.family);
  return parsed.ok ? parsed.value : null;
}

function uniqueSortedFamilies(metadata: readonly unknown[]): readonly string[] {
  const families = new Map<string, string>();
  for (const item of metadata) {
    const family = familyFromMetadata(item);
    if (family === null || family.length === 0) continue;
    const key = family.toLowerCase();
    if (!families.has(key)) families.set(key, family);
  }
  const collator = new Intl.Collator('en', { sensitivity: 'base', usage: 'sort' });
  return [...families.values()].sort((left, right) => {
    const insensitive = collator.compare(left, right);
    return insensitive === 0 ? left.localeCompare(right) : insensitive;
  });
}

function isPermissionDenial(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false;
  return error.name === 'NotAllowedError' || error.name === 'SecurityError';
}

/** Enumerates installed family names when called from a user-activation handler. */
export async function discoverLocalFonts(
  source: unknown = globalThis,
): Promise<LocalFontAccessResult> {
  if (!supportsLocalFontAccess(source)) return { status: 'unsupported' };
  try {
    const metadata = await source.queryLocalFonts();
    if (!Array.isArray(metadata)) return { status: 'error' };
    return { status: 'success', families: uniqueSortedFamilies(metadata) };
  } catch (error: unknown) {
    return isPermissionDenial(error) ? { status: 'denied' } : { status: 'error' };
  }
}
