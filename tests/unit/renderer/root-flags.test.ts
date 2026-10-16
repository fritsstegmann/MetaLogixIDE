import { describe, it, expect } from 'vitest';
import { applyRootFlags, parseFrostTerminalQuery, type RootFlagTarget } from '@renderer/root-flags';
import { FROST_ATTR, MAC_PLATFORM } from '@renderer/frosted-chrome-contract';

function fakeTarget(): RootFlagTarget & { set: Record<string, string>; removed: string[] } {
  const set: Record<string, string> = {};
  const removed: string[] = [];
  return {
    set,
    removed,
    setAttribute(name: string, value: string): void { set[name] = value; },
    removeAttribute(name: string): void { removed.push(name); Reflect.deleteProperty(set, name); },
  };
}

describe('applyRootFlags — platform', () => {
  it('sets data-platform="mac" on darwin', () => {
    const el = fakeTarget();
    applyRootFlags(el, { platform: 'darwin', frostTerminal: false });
    expect(el.set[FROST_ATTR.platform]).toBe(MAC_PLATFORM);
  });

  it.each(['win32', 'linux', undefined])('never sets data-platform for platform %s', (platform) => {
    const el = fakeTarget();
    applyRootFlags(el, { platform, frostTerminal: false });
    expect(el.set[FROST_ATTR.platform]).toBeUndefined();
    expect(el.removed).not.toContain(FROST_ATTR.platform);
  });

  it.each(['win32', 'linux', undefined])('never sets data-platform for platform %s even with frostTerminal true', (platform) => {
    const el = fakeTarget();
    applyRootFlags(el, { platform, frostTerminal: true });
    expect(el.set[FROST_ATTR.platform]).toBeUndefined();
  });
});

describe('applyRootFlags — frost terminal', () => {
  it('sets data-frost-terminal when true', () => {
    const el = fakeTarget();
    applyRootFlags(el, { platform: 'darwin', frostTerminal: true });
    expect(el.set[FROST_ATTR.frostTerminal]).toBe('');
  });

  it('removes data-frost-terminal when false', () => {
    const el = fakeTarget();
    applyRootFlags(el, { platform: 'darwin', frostTerminal: false });
    expect(el.removed).toContain(FROST_ATTR.frostTerminal);
    expect(el.set[FROST_ATTR.frostTerminal]).toBeUndefined();
  });

  it('applies frostTerminal independently of platform', () => {
    const el = fakeTarget();
    applyRootFlags(el, { platform: 'win32', frostTerminal: true });
    expect(el.set[FROST_ATTR.frostTerminal]).toBe('');
  });
});

describe('parseFrostTerminalQuery', () => {
  it('accepts only an exact frostTerminal=1', () => {
    expect(parseFrostTerminalQuery('?frostTerminal=1')).toBe(true);
    expect(parseFrostTerminalQuery('frostTerminal=1')).toBe(true);
  });

  it.each(['', '?frostTerminal=0', '?frostTerminal=true', '?other=1', '?frostTerminal=1x'])(
    'rejects %s',
    (search) => {
      expect(parseFrostTerminalQuery(search)).toBe(false);
    },
  );

  it('reads frostTerminal alongside other query params', () => {
    expect(parseFrostTerminalQuery('?projectId=5&frostTerminal=1&shellIndex=0')).toBe(true);
  });
});
