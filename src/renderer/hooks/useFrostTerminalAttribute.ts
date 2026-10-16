import { useEffect } from 'react';
import { api } from '@renderer/api';
import { FROST_TERMINAL_SETTING_KEY } from '@renderer/frosted-chrome-contract';
import { applyRootFlags, type RootFlagTarget } from '@renderer/root-flags';

/**
 * Keeps the root's frosted-terminal attribute in sync with the stored `frost_terminal` setting,
 * live. Re-reads `settings:get` on mount (covers a stale first-paint query string after a crash
 * reload) and again on every `settings:changed` for that key, applying the result through
 * `applyRootFlags`. Defaults to `document.documentElement`; tests inject a fake target.
 */
export function useFrostTerminalAttribute(target: RootFlagTarget = document.documentElement): void {
  useEffect(() => {
    async function load(): Promise<void> {
      try {
        const { value } = await api.invoke('settings:get', { key: FROST_TERMINAL_SETTING_KEY });
        applyRootFlags(target, { platform: api.platform, frostTerminal: Boolean(value) });
      } catch (e) {
        console.error('frost terminal setting load failed', e);
      }
    }
    void load();
    const off = api.on('settings:changed', ({ key }) => {
      if (key === FROST_TERMINAL_SETTING_KEY) void load();
    });
    return () => { off(); };
  }, [target]);
}
