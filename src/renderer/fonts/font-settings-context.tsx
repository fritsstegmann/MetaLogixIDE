import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  FONT_SETTING_KEYS,
  parseFontFamilyPreference,
  type FontFamilyPreference,
  type FontSettingKey,
} from '@shared/font-settings';
import { api } from '@renderer/api';

export interface FontSettingsSnapshot {
  readonly uiFontFamily: FontFamilyPreference;
  readonly terminalFontFamily: FontFamilyPreference;
  readonly ready: boolean;
}

const INITIAL_SNAPSHOT: FontSettingsSnapshot = {
  uiFontFamily: null,
  terminalFontFamily: null,
  ready: false,
};

const FontSettingsContext = createContext<FontSettingsSnapshot | null>(null);

/** Supplies one synchronized font-preference snapshot to each renderer window. */
export function FontSettingsProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<FontSettingsSnapshot>(INITIAL_SNAPSHOT);
  const versions = useRef<Record<FontSettingKey, number>>({ ui_font_family: 0, terminal_font_family: 0 });
  const mounted = useRef(false);

  const refresh = useCallback(async (key: FontSettingKey): Promise<void> => {
    const version = versions.current[key] + 1;
    versions.current[key] = version;
    const response = await api.invoke('settings:get', { key });
    const parsed = parseFontFamilyPreference(response.value);
    if (!parsed.ok) throw new Error(`invalid persisted ${key}: ${parsed.error}`);
    if (!mounted.current || versions.current[key] !== version) return;
    setSnapshot((current) => key === 'ui_font_family'
      ? { ...current, uiFontFamily: parsed.value }
      : { ...current, terminalFontFamily: parsed.value });
  }, []);

  useEffect(() => {
    mounted.current = true;
    const initial = Promise.allSettled(FONT_SETTING_KEYS.map((key) => refresh(key))).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') console.error('font setting load failed', result.reason);
      }
      if (mounted.current) setSnapshot((current) => ({ ...current, ready: true }));
    });
    void initial;
    const off = api.on('settings:changed', ({ key }) => {
      if (key !== 'ui_font_family' && key !== 'terminal_font_family') return;
      void refresh(key).catch((error: unknown) => console.error('font setting refresh failed', error));
    });
    return () => {
      mounted.current = false;
      off();
    };
  }, [refresh]);

  const value = useMemo(() => snapshot, [snapshot]);
  return <FontSettingsContext.Provider value={value}>{children}</FontSettingsContext.Provider>;
}

/** Reads the current renderer window's synchronized UI and terminal font preferences. */
export function useFontSettings(): FontSettingsSnapshot {
  const value = useContext(FontSettingsContext);
  if (value === null) throw new Error('useFontSettings must be used within FontSettingsProvider');
  return value;
}
