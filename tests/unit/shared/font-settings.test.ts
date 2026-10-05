import { describe, expect, it } from 'vitest';
import {
  FONT_SETTING_KEYS,
  MAX_FONT_FAMILY_CODE_POINTS,
  TERMINAL_FONT_FALLBACK,
  UI_FONT_FALLBACK,
  isFontSettingKey,
  parseFontFamilyPreference,
} from '@shared/font-settings';

describe('parseFontFamilyPreference', () => {
  it('accepts null as reset', () => {
    expect(parseFontFamilyPreference(null)).toEqual({ ok: true, value: null });
  });

  it('trims outer whitespace and preserves printable punctuation and non-ASCII', () => {
    expect(parseFontFamilyPreference('  Nerd, "Quoted"; Ünicode  ')).toEqual({
      ok: true,
      value: 'Nerd, "Quoted"; Ünicode',
    });
  });

  it.each(['', '   ', '\0', 'Font\nName', 'Font\tName'])('rejects empty or C0 input %j', (value) => {
    expect(parseFontFamilyPreference(value).ok).toBe(false);
  });

  it('accepts exactly 256 Unicode code points and rejects 257', () => {
    const glyph = '𝄞';
    expect(Array.from(glyph.repeat(MAX_FONT_FAMILY_CODE_POINTS))).toHaveLength(256);
    expect(parseFontFamilyPreference(glyph.repeat(256)).ok).toBe(true);
    expect(parseFontFamilyPreference(glyph.repeat(257)).ok).toBe(false);
  });

  it.each([undefined, 1, true, {}, []])('rejects non-string input %j', (value) => {
    expect(parseFontFamilyPreference(value).ok).toBe(false);
  });
});

describe('font settings contract', () => {
  it('keeps exactly two independent keys', () => {
    expect(FONT_SETTING_KEYS).toEqual(['ui_font_family', 'terminal_font_family']);
    expect(isFontSettingKey('ui_font_family')).toBe(true);
    expect(isFontSettingKey('terminal_font_family')).toBe(true);
    expect(isFontSettingKey('theme')).toBe(false);
  });

  it('pins the compatibility fallback stacks', () => {
    expect(UI_FONT_FALLBACK).toBe('-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif');
    expect(TERMINAL_FONT_FALLBACK).toBe('"SF Mono", "JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace');
  });
});
