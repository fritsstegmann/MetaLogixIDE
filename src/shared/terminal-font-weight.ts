/** Settings key for the integrated-terminal font weight. Write via settings:set-terminal-font-weight only. */
export const TERMINAL_FONT_WEIGHT_KEY = 'terminal_font_weight' as const;

/** The nine CSS weights a user can choose for normal terminal text. */
export const TERMINAL_FONT_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

export type TerminalFontWeight = (typeof TERMINAL_FONT_WEIGHTS)[number];

/** Weight used when nothing (or something invalid) is stored; equals xterm's 'normal'. */
export const TERMINAL_FONT_WEIGHT_DEFAULT: TerminalFontWeight = 400;

export type TerminalFontWeightParseResult =
  | { readonly ok: true; readonly value: TerminalFontWeight }
  | { readonly ok: false; readonly error: string };

/** Validator shared by main and renderer: accepts only a number in TERMINAL_FONT_WEIGHTS. */
export function parseTerminalFontWeight(value: unknown): TerminalFontWeightParseResult {
  if (typeof value === 'number' && (TERMINAL_FONT_WEIGHTS as readonly number[]).includes(value)) {
    return { ok: true, value: value as TerminalFontWeight };
  }
  return { ok: false, error: 'terminal font weight must be one of 100, 200, ... 900' };
}

/** Bold weight derived from the normal weight: min(weight + 300, 900). */
export function terminalBoldWeight(weight: TerminalFontWeight): TerminalFontWeight {
  return Math.min(weight + 300, 900) as TerminalFontWeight;
}
