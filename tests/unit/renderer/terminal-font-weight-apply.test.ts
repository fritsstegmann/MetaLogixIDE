/** Tests the xterm option pair built from a terminal font weight: normal text at W, bold at min(max(W + 200, 700), 900), as numbers (AC3, AC4). */
import { describe, expect, it } from 'vitest';
import { terminalFontWeightOptions } from '@renderer/terminal-font-weight-apply';

describe('terminalFontWeightOptions', () => {
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
  ] as const)('maps weight %i to itself and bold to %i', (weight, bold) => {
    expect(terminalFontWeightOptions(weight)).toEqual({ fontWeight: weight, fontWeightBold: bold });
  });
});
