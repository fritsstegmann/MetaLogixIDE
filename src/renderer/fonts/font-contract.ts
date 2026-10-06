export const UI_FONT_CSS_PROPERTY = '--metaide-ui-font-family';

export const FONT_TEST_IDS = {
  uiInput: 'ui-font-input',
  /** The "System default" option in the UI font list. */
  uiReset: 'ui-font-reset',
  uiStatus: 'ui-font-status',
  terminalInput: 'terminal-font-input',
  /** The "System default" option in the terminal font list. */
  terminalReset: 'terminal-font-reset',
  terminalStatus: 'terminal-font-status',
} as const;

export const FONT_COPY = {
  sectionLabel: 'Fonts',
  uiLabel: 'Interface',
  terminalLabel: 'Terminal',
  defaultValue: 'System default',
  loading: 'Loading installed fonts…',
  retry: 'Retry',
  saving: 'Saving…',
  saveFailed: 'Could not save this font. Your previous font remains active.',
  emptyName: 'Enter a font family or choose System default.',
  customOption: (family: string): string => `Use “${family}”`,
  discoveryUnsupported: 'Installed fonts can’t be listed here. Type an exact family name.',
  discoveryDenied: 'Access to installed fonts was denied. Type an exact family name.',
  discoveryError: 'Installed fonts could not be loaded. Type an exact family name.',
  unavailable: 'Font is not available on this computer.',
  unknown: 'Font availability is unknown.',
} as const;
