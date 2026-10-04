import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { api } from '@renderer/api';

export type ThemeMode = 'system' | 'light' | 'dark';

// v2: key bump so installs that auto-persisted the old 'system' default
// re-default to dark; explicit choices made after this persist normally.
const STORAGE_KEY = 'metaide.theme.v2';

function readInitial(): ThemeMode {
  const v = localStorage.getItem(STORAGE_KEY);
  // First run defaults to dark (the product look); users can still opt
  // into light or system-follow via Settings or the theme toggle.
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'dark';
}

function applyToDom(mode: ThemeMode): void {
  const el = document.documentElement;
  if (mode === 'system') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', mode);
}

/**
 * Explicit theme control. Users can pick light, dark, or system (follow OS).
 * Persists locally and also syncs Electron's nativeTheme.themeSource so
 * vibrancy chrome (traffic lights, window materials) matches.
 */
export function useTheme(): {
  mode: ThemeMode;
  effective: 'light' | 'dark';
  setMode: (m: ThemeMode) => void;
  cycle: () => void;
} {
  const [mode, setModeState] = useState<ThemeMode>(readInitial);
  const [systemDark, setSystemDark] = useState<boolean>(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  // Apply before the browser paints so a persisted light theme never flashes
  // the dark default during startup or reload.
  useLayoutEffect(() => {
    applyToDom(mode);
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  useEffect(() => {
    void api.invoke('app:set-native-theme', { source: mode });
  }, [mode]);

  // Track OS scheme when in system mode so `effective` stays accurate.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const effective: 'light' | 'dark' = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

  const setMode = useCallback((m: ThemeMode) => setModeState(m), []);

  // Icon click: always flip to the opposite of what's currently RENDERED,
  // regardless of whether we're in system-follow. This is the intuitive
  // "toggle light/dark" behaviour. Users can pick 'system' explicitly in
  // Settings or the Command Palette.
  const cycle = useCallback(() => {
    setModeState((prev) => {
      const currentEffective = prev === 'system' ? (systemDark ? 'dark' : 'light') : prev;
      return currentEffective === 'dark' ? 'light' : 'dark';
    });
  }, [systemDark]);

  return { mode, effective, setMode, cycle };
}
