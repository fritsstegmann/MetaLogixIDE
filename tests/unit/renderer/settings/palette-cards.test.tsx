import { describe, it, expect, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PaletteCards } from '@renderer/components/settings/PaletteCards';
import type { ThemePalette } from '@renderer/hooks/useTheme';

type Props = Record<string, unknown> & { children?: ReactNode };

interface Card {
  attrs: string;
  inner: string;
}

const AC15A: Record<'dark' | 'light', Record<string, string[]>> = {
  dark: {
    Default: ['#1c2028', '#3b82f6', '#22c55e', '#fbbf24'],
    Catppuccin: ['#1e1e2e', '#89b4fa', '#a6e3a1', '#f5c2e7'],
    'Rosé Pine': ['#191724', '#c4a7e7', '#9ccfd8', '#f6c177'],
  },
  light: {
    Default: ['#eceef3', '#2563eb', '#16a34a', '#d97706'],
    Catppuccin: ['#eff1f5', '#1e66f5', '#40a02b', '#ea76cb'],
    'Rosé Pine': ['#faf4ed', '#907aa9', '#56949f', '#ea9d34'],
  },
};

const PALETTES: ThemePalette[] = ['default', 'catppuccin', 'rose-pine'];

function render(palette: ThemePalette, effective: 'light' | 'dark'): string {
  return renderToStaticMarkup(<PaletteCards palette={palette} effective={effective} onSelect={() => {}} />);
}

function cards(html: string): Card[] {
  const found = [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map((m) => ({ attrs: m[1] ?? '', inner: m[2] ?? '' }));
  expect(found).toHaveLength(3);
  return found;
}

function accessibleName(inner: string): string {
  return inner.replace(/<svg.*?<\/svg>/g, '').replace(/<span aria-hidden="true".*?<\/span><\/span>/g, '').replace(/<[^>]+>/g, '').trim();
}

function swatches(inner: string): string[] {
  return [...inner.matchAll(/style="background:\s*([^;"]+);?"/g)].map((m) => m[1] ?? '');
}

function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}

describe('PaletteCards', () => {
  it('renders three buttons named exactly Default, Catppuccin and Rosé Pine', () => {
    const cs = cards(render('default', 'dark'));
    expect(cs.map((c) => accessibleName(c.inner))).toEqual(['Default', 'Catppuccin', 'Rosé Pine']);
    for (const c of cs) expect(c.attrs).toContain('type="button"');
  });

  it.each(PALETTES)('with %s selected only that card is pressed and carries the check icon', (palette) => {
    const cs = cards(render(palette, 'dark'));
    const index = PALETTES.indexOf(palette);
    expect(cs.map((c) => /aria-pressed="([^"]*)"/.exec(c.attrs)?.[1])).toEqual(PALETTES.map((_, i) => String(i === index)));
    expect(cs.map((c) => c.inner.includes('<svg'))).toEqual(PALETTES.map((_, i) => i === index));
    expect(cs[index]?.inner).toMatch(/<svg[^>]*aria-hidden="true"[^>]*width="14"[^>]*height="14"/);
  });

  it('gives only the selected card the accent-soft fill and inset accent ring', () => {
    const cs = cards(render('catppuccin', 'light'));
    expect(cs.map((c) => c.attrs.includes('bg-[--accent-soft]'))).toEqual([false, true, false]);
    expect(cs.map((c) => c.attrs.includes('shadow-[inset_0_0_0_1.5px_var(--accent)]'))).toEqual([false, true, false]);
  });

  it.each(['dark', 'light'] as const)('each card previews its own %s swatch set whichever palette is selected', (effective) => {
    for (const palette of PALETTES) {
      const cs = cards(render(palette, effective));
      for (const c of cs) {
        expect(swatches(c.inner)).toEqual(AC15A[effective][accessibleName(c.inner)]);
      }
    }
  });

  it('keeps the swatch bar hidden from assistive technology', () => {
    for (const c of cards(render('default', 'dark'))) {
      expect(c.inner).toMatch(/^<span aria-hidden="true"[^>]*>(<span[^>]*style="background:[^"]*"[^>]*><\/span>){4}<\/span>/);
    }
  });

  it('uses no literal colour in card chrome classes', () => {
    for (const c of cards(render('rose-pine', 'dark'))) {
      const classes = [...`${c.attrs}${c.inner}`.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(' ');
      expect(classes).not.toMatch(/#|rgb|hsl/i);
    }
  });

  it('clicking a card selects its palette', () => {
    const onSelect = vi.fn();
    const buttons = elements(PaletteCards({ palette: 'default', effective: 'dark', onSelect })).filter((e) => e.type === 'button');
    expect(buttons).toHaveLength(3);
    buttons.forEach((b) => (b.props.onClick as () => void)());
    expect(onSelect.mock.calls).toEqual([['default'], ['catppuccin'], ['rose-pine']]);
  });
});
