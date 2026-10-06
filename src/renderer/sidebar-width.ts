import { useState } from 'react';
import { usePersistedNumber } from '@renderer/hooks/usePersistedNumber';

/** Sidebar width bounds and default, in CSS px. */
export const SIDEBAR_WIDTH = { default: 260, min: 200, max: 560 } as const;

/** The previous default, which every existing install has stored. */
export const LEGACY_DEFAULT_WIDTH = 288;

const WIDTH_KEY = 'metaide.sidebarWidth';
const MIGRATED_KEY = 'metaide.sidebarWidth.migrated';

/**
 * One-time migration of a stored legacy default width: the first time it runs
 * it removes a stored width of exactly `LEGACY_DEFAULT_WIDTH` so the new default
 * applies, keeps any other width, and sets a marker so later runs do nothing.
 */
export function migrateLegacySidebarWidth(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
): void {
  if (storage.getItem(MIGRATED_KEY) === '1') return;
  if (storage.getItem(WIDTH_KEY) === String(LEGACY_DEFAULT_WIDTH)) storage.removeItem(WIDTH_KEY);
  storage.setItem(MIGRATED_KEY, '1');
}

/** Persisted sidebar width, clamped to SIDEBAR_WIDTH; the legacy migration runs before the first read. */
export function useSidebarWidth(): [number, (v: number) => void] {
  useState(() => migrateLegacySidebarWidth(localStorage));
  return usePersistedNumber(WIDTH_KEY, SIDEBAR_WIDTH.default, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max);
}
