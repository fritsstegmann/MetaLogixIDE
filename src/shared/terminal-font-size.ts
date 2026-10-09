/** Settings key for the integrated-terminal font size. Write via settings:set-terminal-font-size only. */
export const TERMINAL_FONT_SIZE_KEY = 'terminal_font_size' as const;

/** Bounds, step and default for the integrated-terminal font size, in px. */
export const TERMINAL_FONT_SIZE = { min: 9, max: 28, step: 1, default: 14 } as const;

/** localStorage key used before the size moved into the settings store; read only for the one-time migration. */
export const LEGACY_SHELL_FONT_SIZE_STORAGE_KEY = 'metaide.shellFontSize';

export type TerminalFontSizeParseResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: string };

export type TerminalFontSizeStep = 'in' | 'out' | 'reset';

/** Main-side validator: integer within [min, max]; anything else is rejected. */
export function parseTerminalFontSize(_value: unknown): TerminalFontSizeParseResult {
  void [_value];
  throw new Error('not implemented');
}

/** Rounds then clamps any finite number into [min, max]. */
export function clampTerminalFontSize(_value: number): number {
  void [_value];
  throw new Error('not implemented');
}

/** Next size for a zoom key; at a bound returns `current` unchanged. */
export function stepTerminalFontSize(_current: number, _step: TerminalFontSizeStep): number {
  void [_current, _step];
  throw new Error('not implemented');
}

/** AC10 rule: valid finite legacy text → clampTerminalFontSize(n); otherwise TERMINAL_FONT_SIZE.default. */
export function migratedTerminalFontSize(_legacyRaw: string | null): number {
  void [_legacyRaw];
  throw new Error('not implemented');
}
