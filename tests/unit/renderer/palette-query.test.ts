/**
 * `parsePaletteQuery`: the first character of the raw query picks the search mode (AC39), the rest,
 * leading spaces removed, is the search text (AC33, AC41, AC42).
 */
import { describe, it, expect } from 'vitest';
import { parsePaletteQuery } from '@renderer/palette-query';

describe('parsePaletteQuery', () => {
  it('maps an empty query to normal mode with empty text', () => {
    expect(parsePaletteQuery('')).toEqual({ mode: 'all', text: '' });
  });

  it.each([
    ['@', 'files'],
    ['#', 'projects'],
    ['>', 'commands'],
  ] as const)('maps a leading %s to %s mode', (prefix, mode) => {
    expect(parsePaletteQuery(`${prefix}foo`)).toEqual({ mode, text: 'foo' });
    expect(parsePaletteQuery(prefix)).toEqual({ mode, text: '' });
  });

  it('ignores spaces between the prefix and the text', () => {
    expect(parsePaletteQuery('@   app.tsx')).toEqual({ mode: 'files', text: 'app.tsx' });
    expect(parsePaletteQuery('#  demo')).toEqual({ mode: 'projects', text: 'demo' });
  });

  it('keeps trailing and inner spaces in the text', () => {
    expect(parsePaletteQuery('> new term ')).toEqual({ mode: 'commands', text: 'new term ' });
  });

  it('treats a prefix character anywhere but index 0 as plain text', () => {
    expect(parsePaletteQuery('foo@bar')).toEqual({ mode: 'all', text: 'foo@bar' });
    expect(parsePaletteQuery('a#b>c')).toEqual({ mode: 'all', text: 'a#b>c' });
  });

  it('treats a prefix after leading spaces as plain text in normal mode', () => {
    expect(parsePaletteQuery('  @foo')).toEqual({ mode: 'all', text: '@foo' });
  });

  it('uses normal mode for any other first character', () => {
    for (const raw of ['!x', '/x', '$x', 'x', '*', '<x']) {
      expect(parsePaletteQuery(raw).mode, raw).toBe('all');
    }
  });

  it('keeps a second prefix character as text', () => {
    expect(parsePaletteQuery('>>x')).toEqual({ mode: 'commands', text: '>x' });
    expect(parsePaletteQuery('#@x')).toEqual({ mode: 'projects', text: '@x' });
  });
});
