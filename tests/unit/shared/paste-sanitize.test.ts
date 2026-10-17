import { describe, it, expect } from 'vitest';
import { sanitizePaste } from '@shared/paste-sanitize';

const KEPT = new Set([0x09, 0x0a, 0x0d]);
const REPLACED = [
  ...Array.from({ length: 0x20 }, (_, code) => code).filter((code) => !KEPT.has(code)),
  0x7f,
];

describe('sanitizePaste (AC2)', () => {
  it.each(REPLACED.map((code) => [code.toString(16).padStart(2, '0'), code]))(
    'replaces control character 0x%s with a space',
    (_hex, code) => {
      expect(sanitizePaste(`a${String.fromCharCode(code as number)}b`)).toBe('a b');
    },
  );

  it('neutralises an embedded bracketed-paste terminator so it cannot end the paste early', () => {
    expect(sanitizePaste('x\x1b[201~rm -rf ~')).toBe('x [201~rm -rf ~');
  });

  it('preserves TAB, LF and CR', () => {
    expect(sanitizePaste('a\tb\nc\r\nd')).toBe('a\tb\nc\r\nd');
  });

  it('leaves printable ASCII, non-ASCII and astral characters untouched', () => {
    const text = 'echo "héllo" ~/日本/€ 🎉 \u0085  ';
    expect(sanitizePaste(text)).toBe(text);
  });

  it('replaces every occurrence, not only the first', () => {
    expect(sanitizePaste('\x00\x07\x1b\x7f')).toBe('    ');
  });

  it('returns an empty string unchanged', () => {
    expect(sanitizePaste('')).toBe('');
  });
});
