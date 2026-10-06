import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { api } from '@renderer/api';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ThemePalette = 'default' | 'catppuccin' | 'rose-pine';

const STORAGE_KEY = 'metaide.theme.v2';
const PALETTE_KEY = 'metaide.theme.palette';
const CHANGE_EVENT = 'metaide:theme-changed';

function readMode(): ThemeMode {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'dark';
}

function readPalette(): ThemePalette {
  const value = localStorage.getItem(PALETTE_KEY);
  return value === 'catppuccin' || value === 'rose-pine' ? value : 'default';
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

function savePreference(key: string, value: string): void {
  localStorage.setItem(key, value);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Persistent palette and appearance preferences shared by controls and renderer windows; native chrome follows the appearance mode. */
export function useTheme(): {
  mode: ThemeMode;
  palette: ThemePalette;
  effective: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
  setPalette: (palette: ThemePalette) => void;
  cycle: () => void;
} {
  const mode = useSyncExternalStore(subscribe, readMode);
  const palette = useSyncExternalStore(subscribe, readPalette);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useLayoutEffect(() => {
    const el = document.documentElement;
    if (mode === 'system') el.removeAttribute('data-theme');
    else if (el.getAttribute('data-theme') !== mode) el.setAttribute('data-theme', mode);
    if (el.getAttribute('data-palette') !== palette) el.setAttribute('data-palette', palette);
  }, [mode, palette]);

  useEffect(() => {
    void api.invoke('app:set-native-theme', { source: mode });
  }, [mode]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const effective = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
  const setMode = useCallback((next: ThemeMode) => savePreference(STORAGE_KEY, next), []);
  const setPalette = useCallback((next: ThemePalette) => savePreference(PALETTE_KEY, next), []);
  const cycle = useCallback(() => {
    const current = readMode();
    const dark = current === 'system' ? systemDark : current === 'dark';
    savePreference(STORAGE_KEY, dark ? 'light' : 'dark');
  }, [systemDark]);

  return { mode, palette, effective, setMode, setPalette, cycle };
}
