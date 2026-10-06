import { describe, expect, it } from 'vitest';
import { ROOT_HUE_TOKENS, rootHueToken, rootHueVar } from '@renderer/root-hue';

describe('rootHueToken', () => {
  it('returns the same token for the same path', () => {
    const path = '/Users/frits/Projects/Metalogix';
    expect(rootHueToken(path)).toBe(rootHueToken(path));
  });

  it('ignores trailing separators', () => {
    expect(rootHueToken('/Users/frits/Projects/Trixta/')).toBe(rootHueToken('/Users/frits/Projects/Trixta'));
    expect(rootHueToken('C:\\code\\repo\\')).toBe(rootHueToken('C:\\code\\repo'));
  });

  it('always returns one of the palette hue tokens, including for an empty path', () => {
    for (const p of ['', '/', 'a', '/Users/frits/Projects/Personal', '~/Projects/Ünïcode']) {
      expect(ROOT_HUE_TOKENS).toContain(rootHueToken(p));
    }
  });

  it('spreads typical roots across every hue', () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => rootHueToken(`/Users/me/Projects/root-${i}`)));
    expect(seen.size).toBe(ROOT_HUE_TOKENS.length);
  });
});

describe('rootHueVar', () => {
  it('wraps the token in var()', () => {
    const path = '/Users/frits/Projects/Personal';
    expect(rootHueVar(path)).toBe(`var(${rootHueToken(path)})`);
  });
});
