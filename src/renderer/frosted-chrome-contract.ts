/** Root/region attributes the mac frosted-chrome CSS keys on. CSS cannot import this; frosted-chrome-css.test.ts asserts the stylesheet uses these exact strings. */
export const FROST_ATTR = {
  platform: 'data-platform',
  frostTerminal: 'data-frost-terminal',
  chromeRoot: 'data-chrome-root',
  sheetContent: 'data-sheet-content',
} as const;
export const MAC_PLATFORM = 'mac' as const;
export type SheetContent = 'shell' | 'other';
export { FROST_TERMINAL_QUERY_KEY } from '@shared/frost-terminal';
export const FROST_TERMINAL_SETTING_KEY = 'frost_terminal' as const;
export const FROST_COPY = {
  label: 'Frosted terminal',
  description: 'Let the desktop show through the terminal (macOS).',
} as const;
export const FROST_TESTIDS = { toggle: 'frost-terminal-toggle' } as const;
