import { describe, it, expect } from 'vitest';
import { paletteKeyAction } from '@renderer/palette-keys';
import type { PaletteKeyEvent } from '@renderer/command-palette-contract';

const key = (k: string, mods: Partial<Omit<PaletteKeyEvent, 'key'>> = {}): PaletteKeyEvent => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('paletteKeyAction', () => {
  it.each([false, true])('toggles on Cmd+K and Ctrl+K (open=%s)', (isOpen) => {
    expect(paletteKeyAction(key('k', { metaKey: true }), isOpen)).toEqual({ kind: 'toggle' });
    expect(paletteKeyAction(key('k', { ctrlKey: true }), isOpen)).toEqual({ kind: 'toggle' });
  });

  it.each([false, true])('opens with ">" on Cmd+Shift+P whatever case the key reports (open=%s)', (isOpen) => {
    expect(paletteKeyAction(key('P', { metaKey: true, shiftKey: true }), isOpen)).toEqual({ kind: 'open', seed: '>' });
    expect(paletteKeyAction(key('p', { metaKey: true, shiftKey: true }), isOpen)).toEqual({ kind: 'open', seed: '>' });
    expect(paletteKeyAction(key('P', { ctrlKey: true, shiftKey: true }), isOpen)).toEqual({ kind: 'open', seed: '>' });
  });

  it.each([false, true])('opens with "@" on Cmd+P and Ctrl+P (open=%s)', (isOpen) => {
    expect(paletteKeyAction(key('p', { metaKey: true }), isOpen)).toEqual({ kind: 'open', seed: '@' });
    expect(paletteKeyAction(key('p', { ctrlKey: true }), isOpen)).toEqual({ kind: 'open', seed: '@' });
  });

  it('treats Option chords as non-palette keys: Cmd+Option+K / Cmd+Option+P pass while closed, are swallowed while open', () => {
    for (const k of ['k', 'p', 'P']) {
      const e = key(k, { metaKey: true, altKey: true, shiftKey: k === 'P' });
      expect(paletteKeyAction(e, false), k).toEqual({ kind: 'pass' });
      expect(paletteKeyAction(e, true), k).toEqual({ kind: 'swallow' });
    }
  });

  it('leaves Cmd+Shift+K to the prompt library', () => {
    expect(paletteKeyAction(key('k', { metaKey: true, shiftKey: true }), false)).toEqual({ kind: 'pass' });
    expect(paletteKeyAction(key('K', { metaKey: true, shiftKey: true }), false)).toEqual({ kind: 'pass' });
  });

  it.each([',', 'n', 'N', 'f', 'F', 'O', '/', 'b', 't', 'T', '\\'])(
    'swallows the other mod-chord Cmd+%s while open',
    (k) => {
      expect(paletteKeyAction(key(k, { metaKey: true, shiftKey: k !== k.toLowerCase() }), true)).toEqual({ kind: 'swallow' });
      expect(paletteKeyAction(key(k, { ctrlKey: true }), true)).toEqual({ kind: 'swallow' });
    },
  );

  it('swallows Cmd+Shift+K while open so the prompt library cannot stack on the palette', () => {
    expect(paletteKeyAction(key('K', { metaKey: true, shiftKey: true }), true)).toEqual({ kind: 'swallow' });
  });

  it.each([',', 'n', 'f', '/', 'b', 't'])('passes Cmd+%s while closed', (k) => {
    expect(paletteKeyAction(key(k, { metaKey: true }), false)).toEqual({ kind: 'pass' });
  });

  it.each([false, true])('passes plain keys (open=%s)', (isOpen) => {
    for (const k of ['k', 'p', 'P', 'Escape', 'Enter', 'ArrowDown', 'a']) {
      expect(paletteKeyAction(key(k), isOpen)).toEqual({ kind: 'pass' });
    }
    expect(paletteKeyAction(key('P', { shiftKey: true }), isOpen)).toEqual({ kind: 'pass' });
    expect(paletteKeyAction(key('k', { altKey: true }), isOpen)).toEqual({ kind: 'pass' });
  });
});
