import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FONT_COPY, FONT_TEST_IDS } from '@renderer/fonts/font-contract';

const hookState: { size: number; ready: boolean; setSize: (n: number) => void } = {
  size: 14,
  ready: true,
  setSize: vi.fn(),
};

vi.mock('@renderer/fonts/terminal-font-size-context', () => ({
  useTerminalFontSize: () => hookState,
}));

function attr(html: string, tag: string, name: string): string | undefined {
  const open = new RegExp(`<${tag}\\b[^>]*>`).exec(html)?.[0] ?? '';
  return new RegExp(`\\s${name}="([^"]*)"`).exec(open)?.[1];
}

describe('TerminalFontSizeControl markup', () => {
  beforeEach(() => {
    hookState.size = 14;
    hookState.ready = true;
    hookState.setSize = vi.fn();
  });

  it('shows the terminal-size label, the exact hint and the px unit', async () => {
    const { TerminalFontSizeControl } = await import('@renderer/components/settings/TerminalFontSizeControl');
    const html = renderToStaticMarkup(<TerminalFontSizeControl />);
    expect(html).toContain(`>${FONT_COPY.terminalSizeLabel}<`);
    expect(html).toContain(FONT_COPY.terminalSizeHint);
    expect(html).toContain(`>${FONT_COPY.terminalSizeUnit}<`);
  });

  it('renders a 9..28 step-1 number spinbutton named "Terminal font size", carrying its test id and the current saved value', async () => {
    hookState.size = 18;
    const { TerminalFontSizeControl } = await import('@renderer/components/settings/TerminalFontSizeControl');
    const html = renderToStaticMarkup(<TerminalFontSizeControl />);
    expect(attr(html, 'input', 'type')).toBe('number');
    expect([attr(html, 'input', 'min'), attr(html, 'input', 'max'), attr(html, 'input', 'step')]).toEqual(['9', '28', '1']);
    expect(attr(html, 'input', 'value')).toBe('18');
    expect(attr(html, 'input', 'data-testid')).toBe(FONT_TEST_IDS.terminalSizeInput);
  });

  it('ties the input to its label by id, giving it an accessible name of exactly "Terminal font size" (AC12)', async () => {
    const { TerminalFontSizeControl } = await import('@renderer/components/settings/TerminalFontSizeControl');
    const html = renderToStaticMarkup(<TerminalFontSizeControl />);
    const id = attr(html, 'input', 'id');
    expect(id).toBeTruthy();
    expect(new RegExp(`<label[^>]*for="${id}"[^>]*>${FONT_COPY.terminalSizeLabel}<`).test(html)).toBe(true);
  });
});
