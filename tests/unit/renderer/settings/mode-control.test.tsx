import { describe, it, expect, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModeControl } from '@renderer/components/settings/ModeControl';
import type { ThemeMode } from '@renderer/hooks/useTheme';

type Props = Record<string, unknown> & { children?: ReactNode };

interface Radio {
  attrs: string;
  inner: string;
}

function render(mode: ThemeMode, effective: 'light' | 'dark'): string {
  return renderToStaticMarkup(<ModeControl mode={mode} effective={effective} onChange={() => {}} />);
}

function radios(html: string): Radio[] {
  return [...html.matchAll(/<button([^>]*role="radio"[^>]*)>(.*?)<\/button>/g)].map((m) => ({
    attrs: m[1] ?? '',
    inner: m[2] ?? '',
  }));
}

function text(inner: string): string {
  return inner.replace(/<[^>]+>/g, '');
}

function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1];
}

function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}

function radioElements(mode: ThemeMode, onChange: (m: ThemeMode) => void): ReactElement<Props>[] {
  const found = elements(ModeControl({ mode, effective: 'dark', onChange })).filter((e) => e.props.role === 'radio');
  expect(found).toHaveLength(3);
  return found;
}

function keyEvent(key: string, focus: (selector: string) => void) {
  return {
    key,
    preventDefault: vi.fn(),
    currentTarget: {
      parentElement: {
        querySelector: (selector: string) => ({ focus: () => focus(selector) }),
      },
    },
  };
}

describe('ModeControl markup', () => {
  it('is a radiogroup named "Mode" holding System, Light and Dark radios in order', () => {
    const html = render('light', 'dark');
    expect(html).toMatch(/^<div[^>]*role="radiogroup"[^>]*aria-label="Mode"|^<div[^>]*aria-label="Mode"[^>]*role="radiogroup"/);
    expect(radios(html).map((r) => text(r.inner))).toEqual(['System · dark', 'Light', 'Dark']);
  });

  it.each(['system', 'light', 'dark'] as const)('with mode %s exactly that radio is checked and alone in the Tab order', (mode) => {
    const rs = radios(render(mode, 'light'));
    const checked = rs.filter((r) => attr(r.attrs, 'aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(text(checked[0]?.inner ?? '').toLowerCase()).toMatch(new RegExp(`^${mode}`));
    expect(rs.filter((r) => attr(r.attrs, 'aria-checked') === 'false')).toHaveLength(2);
    for (const r of rs) {
      expect(attr(r.attrs, 'tabindex')).toBe(attr(r.attrs, 'aria-checked') === 'true' ? '0' : '-1');
      expect(attr(r.attrs, 'type')).toBe('button');
    }
  });

  it.each(['dark', 'light'] as const)('System shows the effective theme %s in a normal-weight suffix with no colour of its own', (effective) => {
    const system = radios(render('dark', effective))[0];
    const suffix = /<span([^>]*)>([^<]*)<\/span>/.exec(system?.inner ?? '');
    expect(suffix?.[2]).toBe(` · ${effective}`);
    const classes = attr(suffix?.[1] ?? '', 'class')?.split(/\s+/) ?? [];
    expect(classes).toContain('font-normal');
    expect(classes.filter((c) => c.startsWith('text-') || c.startsWith('opacity-'))).toEqual([]);
  });

  it('marks only the checked segment with the accent-soft fill', () => {
    const rs = radios(render('dark', 'dark'));
    expect(rs.map((r) => (attr(r.attrs, 'class') ?? '').includes('bg-[--accent-soft]'))).toEqual([false, false, true]);
  });
});

describe('ModeControl interaction', () => {
  it('clicking a radio applies its mode', () => {
    const onChange = vi.fn();
    const [, light] = radioElements('dark', onChange);
    (light?.props.onClick as () => void)();
    expect(onChange).toHaveBeenCalledWith('light');
  });

  it('ArrowRight applies the next mode, focuses its radio and stops page scroll', () => {
    const onChange = vi.fn();
    const focused: string[] = [];
    const [system] = radioElements('system', onChange);
    const event = keyEvent('ArrowRight', (s) => focused.push(s));
    (system?.props.onKeyDown as (e: unknown) => void)(event);
    expect(onChange).toHaveBeenCalledWith('light');
    expect(focused).toEqual(['[data-mode="light"]']);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('ArrowUp from System wraps to Dark', () => {
    const onChange = vi.fn();
    const focused: string[] = [];
    const [system] = radioElements('system', onChange);
    (system?.props.onKeyDown as (e: unknown) => void)(keyEvent('ArrowUp', (s) => focused.push(s)));
    expect(onChange).toHaveBeenCalledWith('dark');
    expect(focused).toEqual(['[data-mode="dark"]']);
  });

  it('non-arrow keys are left alone', () => {
    const onChange = vi.fn();
    const [system] = radioElements('system', onChange);
    const event = keyEvent('Tab', () => {});
    (system?.props.onKeyDown as (e: unknown) => void)(event);
    expect(onChange).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('every radio carries its mode for the focus lookup', () => {
    expect(radioElements('system', () => {}).map((e) => e.props['data-mode'])).toEqual(['system', 'light', 'dark']);
  });
});
