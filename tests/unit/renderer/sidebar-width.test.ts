import { afterEach, describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LEGACY_DEFAULT_WIDTH, SIDEBAR_WIDTH, migrateLegacySidebarWidth, useSidebarWidth } from '@renderer/sidebar-width';

const WIDTH_KEY = 'metaide.sidebarWidth';
const MARKER_KEY = 'metaide.sidebarWidth.migrated';

function fakeStorage(init: Record<string, string> = {}) {
  const map = new Map(Object.entries(init));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

const snapshot = (s: ReturnType<typeof fakeStorage>) => Object.fromEntries(s.map);

describe('sidebar width constants', () => {
  it('defaults to 260 within 200..560, replacing the legacy 288', () => {
    expect(SIDEBAR_WIDTH).toEqual({ default: 260, min: 200, max: 560 });
    expect(LEGACY_DEFAULT_WIDTH).toBe(288);
  });
});

describe('migrateLegacySidebarWidth', () => {
  it('clears a stored legacy 288 and sets the marker', () => {
    const s = fakeStorage({ [WIDTH_KEY]: '288' });
    migrateLegacySidebarWidth(s);
    expect(snapshot(s)).toEqual({ [MARKER_KEY]: '1' });
  });

  it('keeps any other stored width and sets the marker', () => {
    const s = fakeStorage({ [WIDTH_KEY]: '340' });
    migrateLegacySidebarWidth(s);
    expect(snapshot(s)).toEqual({ [WIDTH_KEY]: '340', [MARKER_KEY]: '1' });
  });

  it('keeps a width that only resembles 288', () => {
    const s = fakeStorage({ [WIDTH_KEY]: '288.5' });
    migrateLegacySidebarWidth(s);
    expect(snapshot(s)).toEqual({ [WIDTH_KEY]: '288.5', [MARKER_KEY]: '1' });
  });

  it('stores only the marker when no width is stored', () => {
    const s = fakeStorage();
    migrateLegacySidebarWidth(s);
    expect(snapshot(s)).toEqual({ [MARKER_KEY]: '1' });
  });

  it('leaves a stored 288 alone once the marker is set', () => {
    const s = fakeStorage({ [WIDTH_KEY]: '288', [MARKER_KEY]: '1' });
    migrateLegacySidebarWidth(s);
    expect(snapshot(s)).toEqual({ [WIDTH_KEY]: '288', [MARKER_KEY]: '1' });
  });

  it('runs once: a 288 the user picks after migrating survives later launches', () => {
    const s = fakeStorage({ [WIDTH_KEY]: '288' });
    migrateLegacySidebarWidth(s);
    expect(s.getItem(WIDTH_KEY)).toBeNull();
    s.setItem(WIDTH_KEY, '288');
    migrateLegacySidebarWidth(s);
    expect(s.getItem(WIDTH_KEY)).toBe('288');
  });
});

describe('useSidebarWidth', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function renderedWidth(init: Record<string, string>): string {
    vi.stubGlobal('localStorage', fakeStorage(init));
    const Probe = () => String(useSidebarWidth()[0]);
    return renderToStaticMarkup(createElement(Probe));
  }

  it('reads the default after migrating away a stored legacy 288', () => {
    expect(renderedWidth({ [WIDTH_KEY]: '288' })).toBe('260');
  });

  it('honours any other stored width', () => {
    expect(renderedWidth({ [WIDTH_KEY]: '320' })).toBe('320');
  });

  it('keeps a post-migration 288', () => {
    expect(renderedWidth({ [WIDTH_KEY]: '288', [MARKER_KEY]: '1' })).toBe('288');
  });

  it('clamps a stored width to the bounds', () => {
    expect(renderedWidth({ [WIDTH_KEY]: '900' })).toBe('560');
    expect(renderedWidth({ [WIDTH_KEY]: '50' })).toBe('200');
  });
});
