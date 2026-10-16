import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AppearanceSection,
  FrostTerminalRow,
  GeneralPanel,
  loadBoard,
  setFrostTerminal,
  useBoardSettings,
  type AppearanceSectionProps,
} from '@renderer/components/settings/GeneralPanel';
import { FROST_COPY, FROST_TESTIDS } from '@renderer/frosted-chrome-contract';
import { ShortcutPlatformContext } from '@renderer/shortcut-platform';
import type { ShortcutPlatform } from '@renderer/shortcut-contract';

const rt = vi.hoisted(() => {
  const slots: unknown[] = [];
  let cursor = 0;
  let active = false;
  return {
    get active() { return active; },
    reset() { slots.length = 0; },
    render<T>(fn: () => T): T {
      cursor = 0;
      active = true;
      try { return fn(); } finally { active = false; }
    },
    useState<S>(init: S) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = init;
      const set = (v: S | ((p: S) => S)) => { slots[i] = typeof v === 'function' ? (v as (p: S) => S)(slots[i] as S) : v; };
      return [slots[i] as S, set] as const;
    },
  };
});

vi.mock('react', async (orig) => {
  const real = await orig<typeof import('react')>();
  return {
    ...real,
    useState: ((init: unknown) => (rt.active ? rt.useState(init) : real.useState(init))) as typeof real.useState,
    useEffect: ((run: () => void, deps?: unknown[]) => (rt.active ? undefined : real.useEffect(run, deps))) as typeof real.useEffect,
  };
});
vi.mock('@renderer/api', () => ({ api: { invoke: vi.fn() } }));
vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ mode: 'dark', palette: 'default', effective: 'dark', setMode: () => undefined, setPalette: () => undefined, cycle: () => undefined }),
}));
vi.mock('@renderer/fonts/font-settings-context', () => ({
  useFontSettings: () => ({ uiFontFamily: null, terminalFontFamily: null }),
}));
vi.mock('@renderer/components/FontControl', () => ({ FontControl: () => null }));
vi.mock('@renderer/components/settings/TerminalFontSizeControl', () => ({ TerminalFontSizeControl: () => null }));
vi.mock('@renderer/components/settings/TerminalFontWeightControl', () => ({
  TerminalFontWeightControl: () => null,
  TerminalBoldWeightControl: () => null,
}));

type Props = Record<string, unknown> & { children?: ReactNode };

function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}

function attr(html: string, tag: string, name: string): string | undefined {
  const open = new RegExp(`<${tag}\\b[^>]*>`).exec(html)?.[0] ?? '';
  return new RegExp(`\\s${name}="([^"]*)"`).exec(open)?.[1];
}

const SECTION_PROPS: AppearanceSectionProps = {
  theme: { mode: 'dark', palette: 'default', effective: 'dark' },
  opacity: 100,
  onMode: () => undefined,
  onPalette: () => undefined,
  onOpacity: () => undefined,
  showFrostTerminal: true,
  frostTerminal: false,
  onFrostTerminal: () => undefined,
};

describe('FrostTerminalRow markup', () => {
  it('shows the exact FROST_COPY label and description', () => {
    const html = renderToStaticMarkup(<FrostTerminalRow checked={false} onChange={() => undefined} />);
    expect(html).toContain(`>${FROST_COPY.label}<`);
    expect(html).toContain(FROST_COPY.description);
  });

  it('carries the FROST_TESTIDS.toggle test id and reflects the checked prop', () => {
    const on = renderToStaticMarkup(<FrostTerminalRow checked onChange={() => undefined} />);
    const off = renderToStaticMarkup(<FrostTerminalRow checked={false} onChange={() => undefined} />);
    expect(attr(on, 'input', 'data-testid')).toBe(FROST_TESTIDS.toggle);
    expect(attr(on, 'input', 'checked')).toBe('');
    expect(attr(off, 'input', 'checked')).toBeUndefined();
  });

  it('forwards its onChange straight through to the Switch, which reports the new state when toggled', () => {
    const onChange = vi.fn();
    const switchEl = elements(FrostTerminalRow({ checked: false, onChange })).find(
      (e) => e.props.testId === FROST_TESTIDS.toggle,
    );
    (switchEl?.props.onChange as (next: boolean) => void)(true);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('AppearanceSection — frosted terminal row placement (D9, AC13)', () => {
  it('renders the row directly below Window opacity when showFrostTerminal is true', () => {
    const html = renderToStaticMarkup(<AppearanceSection {...SECTION_PROPS} />);
    const opacityIdx = html.indexOf('data-testid="window-opacity-slider"');
    const toggleIdx = html.indexOf(`data-testid="${FROST_TESTIDS.toggle}"`);
    expect(opacityIdx).toBeGreaterThan(-1);
    expect(toggleIdx).toBeGreaterThan(opacityIdx);
  });

  it('omits the row entirely when showFrostTerminal is false (non-mac, AC13)', () => {
    const html = renderToStaticMarkup(<AppearanceSection {...SECTION_PROPS} showFrostTerminal={false} />);
    expect(html).not.toContain(FROST_TESTIDS.toggle);
    expect(html).not.toContain(FROST_COPY.label);
  });
});

describe('loadBoard — frost_terminal default (AC6)', () => {
  it.each([null, false])('reads OFF for a stored value of %s', async (stored) => {
    const { api } = await import('@renderer/api');
    vi.mocked(api.invoke).mockImplementation(async (_channel: string, req: unknown) => {
      const key = (req as { key?: string }).key;
      if (key === 'frost_terminal') return { value: stored };
      if (key === 'window_opacity') return { value: 100 };
      return { value: null };
    });
    const board = await loadBoard();
    expect(board.frostTerminal).toBe(false);
  });

  it('reads ON for a stored true value', async () => {
    const { api } = await import('@renderer/api');
    vi.mocked(api.invoke).mockImplementation(async (_channel: string, req: unknown) => {
      const key = (req as { key?: string }).key;
      if (key === 'frost_terminal') return { value: true };
      if (key === 'window_opacity') return { value: 100 };
      return { value: null };
    });
    const board = await loadBoard();
    expect(board.frostTerminal).toBe(true);
  });
});

describe('setFrostTerminal', () => {
  it('invokes settings:set-frost-terminal with the new value', async () => {
    const { api } = await import('@renderer/api');
    vi.mocked(api.invoke).mockClear();
    vi.mocked(api.invoke).mockResolvedValue({ ok: true });
    await setFrostTerminal(true);
    expect(api.invoke).toHaveBeenCalledWith('settings:set-frost-terminal', { enabled: true });
  });
});

describe('GeneralPanel — frosted terminal row only on mac (AC13)', () => {
  function panel(platform: ShortcutPlatform): string {
    return renderToStaticMarkup(
      <ShortcutPlatformContext.Provider value={platform}>
        <GeneralPanel fontDiscovery={{ status: 'idle' }} onLoadInstalledFonts={async () => undefined} />
      </ShortcutPlatformContext.Provider>,
    );
  }

  it('renders the toggle under the mac platform', () => {
    expect(panel('mac')).toContain(`data-testid="${FROST_TESTIDS.toggle}"`);
  });

  it('omits the toggle and its copy under any other platform', () => {
    const html = panel('other');
    expect(html).toContain('data-testid="window-opacity-slider"');
    expect(html).not.toContain(FROST_TESTIDS.toggle);
    expect(html).not.toContain(FROST_COPY.label);
  });
});

describe('useBoardSettings — onFrostTerminal persists and reverts on failure', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    rt.reset();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => { errorSpy.mockRestore(); });

  async function toggle(reply: () => Promise<unknown>): Promise<boolean> {
    const { api } = await import('@renderer/api');
    vi.mocked(api.invoke).mockReset();
    vi.mocked(api.invoke).mockImplementation(reply as never);
    const board = rt.render(() => useBoardSettings());
    expect(board.frostTerminal).toBe(false);
    const pending = board.onFrostTerminal(true);
    expect(rt.render(() => useBoardSettings()).frostTerminal).toBe(true);
    await pending;
    expect(api.invoke).toHaveBeenCalledWith('settings:set-frost-terminal', { enabled: true });
    return rt.render(() => useBoardSettings()).frostTerminal;
  }

  it('flips the local value and keeps it when the save succeeds', async () => {
    expect(await toggle(async () => ({ ok: true }))).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('reverts the local value and logs when the main process refuses the value', async () => {
    expect(await toggle(async () => ({ ok: false, error: 'invalid' }))).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('reverts the local value and logs when the IPC call rejects', async () => {
    expect(await toggle(() => Promise.reject(new Error('ipc down')))).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });
});
