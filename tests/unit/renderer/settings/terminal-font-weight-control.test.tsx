/** Contract tests for the terminal font weight Settings row: label, hint, accessible native select with the nine named weights, current value, and selection saving through the shared store (AC1, AC2, AC12). */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FONT_COPY, FONT_TEST_IDS } from '@renderer/fonts/font-contract';
import { TerminalFontWeightControl } from '@renderer/components/settings/TerminalFontWeightControl';
import type { TerminalFontWeight } from '@shared/terminal-font-weight';

vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), useId: () => 'weight-id' }));

const hookState: { weight: TerminalFontWeight; ready: boolean; setWeight: (w: TerminalFontWeight) => void } = {
  weight: 400,
  ready: true,
  setWeight: vi.fn(),
};

vi.mock('@renderer/fonts/terminal-font-weight-context', () => ({
  useTerminalFontWeight: () => hookState,
}));

const EXPECTED_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['100', 'Thin (100)'],
  ['200', 'Extra Light (200)'],
  ['300', 'Light (300)'],
  ['400', 'Regular (400)'],
  ['500', 'Medium (500)'],
  ['600', 'Semibold (600)'],
  ['700', 'Bold (700)'],
  ['800', 'Extra Bold (800)'],
  ['900', 'Black (900)'],
];

function render(): string {
  return renderToStaticMarkup(<TerminalFontWeightControl />);
}

function selectTag(html: string): string {
  return /<select\b[^>]*>/.exec(html)?.[0] ?? '';
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

function options(html: string): Array<[string, string, boolean]> {
  return [...html.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].map((m) => [
    attr(m[1] ?? '', 'value') ?? '',
    m[2] ?? '',
    /\sselected=""/.test(m[1] ?? ''),
  ]);
}

interface SelectProps {
  readonly onChange?: (e: { target: { value: string } }) => void;
  readonly children?: ReactNode;
}

function findSelectOnChange(node: ReactNode): ((e: { target: { value: string } }) => void) | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findSelectOnChange(child as ReactNode);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<SelectProps>(node)) return undefined;
  if (node.type === 'select') return node.props.onChange;
  return findSelectOnChange(node.props.children);
}

function choose(value: string): void {
  const onChange = findSelectOnChange(TerminalFontWeightControl());
  expect(onChange).toBeTypeOf('function');
  onChange?.({ target: { value } });
}

describe('TerminalFontWeightControl markup', () => {
  beforeEach(() => {
    hookState.weight = 400;
    hookState.ready = true;
    hookState.setWeight = vi.fn();
  });

  it('shows the terminal-weight label and the exact hint (AC1)', () => {
    const html = render();
    expect(html).toContain(`>${FONT_COPY.terminalWeightLabel}<`);
    expect(html).toContain(`>${FONT_COPY.terminalWeightHint}<`);
    expect(FONT_COPY.terminalWeightHint).toBe(
      'Bold text is drawn 200 heavier, from 700 up to 900. Fonts without this weight use the nearest one.',
    );
  });

  it('renders a native select named exactly "Terminal font weight" through its label (AC12)', () => {
    const html = render();
    const id = attr(selectTag(html), 'id');
    expect(id).toBeTruthy();
    expect(new RegExp(`<label[^>]*for="${id}"[^>]*>Terminal font weight<`).test(html)).toBe(true);
  });

  it('carries the E2E test id on the select', () => {
    expect(attr(selectTag(render()), 'data-testid')).toBe(FONT_TEST_IDS.terminalWeightSelect);
  });

  it('offers exactly the nine weights in order, each labelled with its CSS name and number (AC1)', () => {
    expect(options(render()).map(([value, label]) => [value, label])).toEqual(EXPECTED_OPTIONS);
  });

  it.each([[400], [100], [900]] as const)('shows the current weight %i as the only selected option (AC3)', (weight) => {
    hookState.weight = weight;
    const selected = options(render()).filter(([, , isSelected]) => isSelected).map(([value]) => value);
    expect(selected).toEqual([String(weight)]);
  });
});

describe('TerminalFontWeightControl selection', () => {
  beforeEach(() => {
    hookState.weight = 400;
    hookState.setWeight = vi.fn();
  });

  it.each([['100', 100], ['700', 700], ['900', 900]] as const)('saves %s immediately as the number %i (AC2)', (raw, weight) => {
    choose(raw);
    expect(hookState.setWeight).toHaveBeenCalledTimes(1);
    expect(hookState.setWeight).toHaveBeenCalledWith(weight);
  });

  it.each([['450'], ['abc'], [''], ['1000']])('ignores an unparseable or out-of-set value %j', (raw) => {
    choose(raw);
    expect(hookState.setWeight).not.toHaveBeenCalled();
  });
});
