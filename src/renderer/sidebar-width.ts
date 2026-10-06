import { usePersistedNumber } from '@renderer/hooks/usePersistedNumber';

/** Sidebar width bounds and default, in CSS px. */
export const SIDEBAR_WIDTH = { default: 260, min: 200, max: 560 } as const;

/** The previous default, which every existing install has stored. */
export const LEGACY_DEFAULT_WIDTH = 288;

/** One-time migration of a stored legacy default width. Stub: implemented by the sidebar slice. */
export function migrateLegacySidebarWidth(
  _storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
): void {
  void _storage; // Intentionally empty until implemented.
}

/** Persisted sidebar width, clamped to SIDEBAR_WIDTH. */
export function useSidebarWidth(): [number, (v: number) => void] {
  return usePersistedNumber('metaide.sidebarWidth', SIDEBAR_WIDTH.default, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max);
}
