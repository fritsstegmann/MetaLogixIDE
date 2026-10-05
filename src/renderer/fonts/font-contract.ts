export const UI_FONT_CSS_PROPERTY = '--metaide-ui-font-family';

export const FONT_TEST_IDS = {
  loadInstalled: 'fonts-load-installed',
  uiInput: 'ui-font-input',
  uiReset: 'ui-font-reset',
  uiStatus: 'ui-font-status',
  terminalInput: 'terminal-font-input',
  terminalReset: 'terminal-font-reset',
  terminalStatus: 'terminal-font-status',
} as const;

export const FONT_COPY = {
  sectionLabel: 'Fonts',
  uiLabel: 'UI font',
  terminalLabel: 'Terminal font',
  loadInstalled: 'Load installed fonts',
  defaultValue: 'Default',
  reset: 'Reset',
  unavailable: 'Font is not available on this computer.',
  unknown: 'Font availability is unknown.',
} as const;
