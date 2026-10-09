import { describe, expect, it } from 'vitest';
import {
  TERMINAL_FONT_WEIGHTS,
  TERMINAL_FONT_WEIGHT_DEFAULT,
  TERMINAL_FONT_WEIGHT_KEY,
  parseTerminalFontWeight,
  terminalBoldWeight,
} from '@shared/terminal-font-weight';

describe('terminal font weight contract', () => {
  it('exposes the agreed key, weights and default', () => {
    expect(TERMINAL_FONT_WEIGHT_KEY).toBe('terminal_font_weight');
    expect(TERMINAL_FONT_WEIGHTS).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(TERMINAL_FONT_WEIGHT_DEFAULT).toBe(400);
  });
});

describe('parseTerminalFontWeight', () => {
  it.each([100, 200, 300, 400, 500, 600, 700, 800, 900])('accepts %j', (value) => {
    expect(parseTerminalFontWeight(value)).toEqual({ ok: true, value });
  });

  it.each([450, 1000, 0, 50, 950, -100, 400.5, NaN, Infinity, 'bold', 'normal', '400', null, undefined, {}, [400]])(
    'rejects %j',
    (value) => {
      const result = parseTerminalFontWeight(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/terminal font weight/);
    },
  );
});

describe('terminalBoldWeight', () => {
  it.each([
    [100, 700],
    [200, 700],
    [300, 700],
    [400, 700],
    [500, 700],
    [600, 800],
    [700, 900],
    [800, 900],
    [900, 900],
  ] as const)('terminalBoldWeight(%j) === %j', (weight, bold) => {
    expect(terminalBoldWeight(weight)).toBe(bold);
  });
});
