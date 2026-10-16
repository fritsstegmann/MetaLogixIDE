import { describe, it, expect, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AppearanceSection,
  FrostTerminalRow,
  loadBoard,
  setFrostTerminal,
  type AppearanceSectionProps,
} from '@renderer/components/settings/GeneralPanel';
import { FROST_COPY, FROST_TESTIDS } from '@renderer/frosted-chrome-contract';

vi.mock('@renderer/api', () => ({ api: { invoke: vi.fn() } }));

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
