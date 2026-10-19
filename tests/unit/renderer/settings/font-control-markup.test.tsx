import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FontDiscoveryState } from '@renderer/components/FontControl';

vi.mock('@renderer/fonts/font-options', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/fonts/font-options')>();
  return {
    ...actual,
    initialPickerState: (value: string | null) => ({ ...actual.initialPickerState(value), open: globalThis.__fontListOpen === true }),
  };
});

declare global {
  var __fontListOpen: boolean | undefined;
}

const { FontControl } = await import('@renderer/components/FontControl');

const noop = async () => undefined;

function render(opts: {
  key?: 'ui_font_family' | 'terminal_font_family';
  value?: string | null;
  open?: boolean;
  discovery?: FontDiscoveryState;
}): string {
  globalThis.__fontListOpen = opts.open ?? false;
  const key = opts.key ?? 'ui_font_family';
  return renderToStaticMarkup(
    <FontControl
      settingKey={key}
      label={key === 'ui_font_family' ? 'Interface' : 'Terminal'}
      value={opts.value ?? null}
      fallback="sans-serif"
      discovery={opts.discovery ?? { status: 'success', families: ['Fira Code', 'Menlo'] }}
      onSave={noop}
      onLoadInstalledFonts={noop}
    />,
  );
}

const tags = (html: string, tag: string) => html.match(new RegExp(`<${tag}\\b[^>]*>`, 'g')) ?? [];
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const options = (html: string) => html.match(/<li\b[^>]*role="option"[^>]*>.*?<\/li>/g) ?? [];

describe('FontControl markup (AC20 row and input)', () => {
  it('uses a 110px label column, 16px gap and a medium-weight label', () => {
    const html = render({});
    const row = tags(html, 'div')[0] ?? '';
    expect(attr(row, 'class')).toContain('sm:grid-cols-[110px_minmax(0,1fr)]');
    expect(attr(row, 'class')).toContain('gap-x-4');
    expect(attr(tags(html, 'label')[0] ?? '', 'class')).toContain('font-medium');
  });

  it('keeps an editable 40px input with radius 10, 14px text and a focus ring', () => {
    const input = tags(render({}), 'input')[0] ?? '';
    const cls = attr(input, 'class') ?? '';
    expect(input).not.toMatch(/\breadonly\b/i);
    expect(cls).toContain('min-h-10');
    expect(cls).toContain('rounded-[10px]');
    expect(cls).toContain('text-sm');
    expect(cls).toContain('focus-visible:ring-2');
    expect(cls).toContain('focus-visible:rounded-[10px]');
    expect(attr(input, 'role')).toBe('combobox');
  });

  it('draws the field caret at 14px with stroke 2', () => {
    const html = render({});
    const pathIndex = html.indexOf('M6 9l6 6 6-6');
    expect(pathIndex).toBeGreaterThan(-1);
    const svgStart = html.lastIndexOf('<svg', pathIndex);
    const caretTag = html.slice(svgStart, html.indexOf('>', svgStart) + 1);
    expect(caretTag).toContain('width="14"');
    expect(caretTag).toContain('height="14"');
    expect(caretTag).toContain('stroke-width="2"');
  });
});

describe('FontControl markup (AC21-AC23 option list)', () => {
  const open = render({ open: true, value: 'Menlo' });
  const list = tags(open, 'ul')[0] ?? '';

  it('keeps bounded scrolling and the popover class, with radius 12, 5px padding and a raised fill', () => {
    const cls = attr(list, 'class') ?? '';
    expect(cls).toContain('popover');
    expect(cls).toContain('max-h-64');
    expect(cls).toContain('overflow-y-auto');
    expect(cls).toContain('rounded-xl');
    expect(cls).toContain('top-[46px]');
    expect(cls).toContain('p-[5px]');
    expect(cls).toContain('bg-[--surface-raised]');
    expect(cls).not.toContain('bg-[--panel-strong]');
  });

  it('renders 34px rows with radius 8 and 14px text', () => {
    const rows = tags(open, 'li').filter((t) => attr(t, 'role') === 'option');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const cls = attr(row, 'class') ?? '';
      expect(cls).toContain('h-[34px]');
      expect(cls).toContain('rounded-lg');
      expect(cls).toContain('text-sm');
    }
  });

  it('shows an SVG check only in the selected row and never a text glyph', () => {
    const rows = options(open);
    const selected = rows.filter((r) => r.includes('aria-selected="true"'));
    expect(open).not.toContain('✓');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain('<svg');
    expect(selected[0]).toContain('width="14"');
    expect(selected[0]).toContain('stroke-width="3"');
    expect(selected[0]).toContain('text-[--accent]');
    expect(selected[0]).toContain('Menlo');
    for (const r of rows.filter((x) => !x.includes('aria-selected="true"'))) {
      expect(r).not.toContain('<svg');
    }
  });

  it('keeps "System default" as an exact-name option, muted, with the reset testid and no note', () => {
    const rows = options(open);
    const def = rows.find((r) => r.includes('data-testid="ui-font-reset"')) ?? '';
    expect(def).toContain('System default');
    expect(def).toMatch(/<span[^>]*text-\[--text-muted\][^>]*>System default<\/span>/);
    expect(def.replace(/<[^>]+>/g, '')).toBe('System default');
    expect(open).not.toContain('SF Mono');
  });

  it('highlights the active row with the hover token', () => {
    const rows = options(render({ open: true, value: null }));
    expect(rows.some((r) => /^<li[^>]*bg-\[--surface-hover\]/.test(r) || /class="[^"]*bg-\[--surface-hover\]/.test(r.slice(0, r.indexOf('>'))))).toBe(true);
  });
});

describe('FontControl markup (AC24 previews, AC25 lines)', () => {
  it('renders the UI preview sentence with its aria-label', () => {
    const html = render({});
    expect(html).toContain('aria-label="Interface preview"');
    expect(html).toContain('The quick brown fox jumps over the lazy dog.');
  });

  it('renders the terminal preview with a role=img glyph span and no branch sample', () => {
    const html = render({ key: 'terminal_font_family' });
    expect(html).toContain('aria-label="Terminal preview"');
    expect(html).toContain('Aa 0O 1l → ~/project ');
    expect(html).not.toContain('⎇');
    expect(html).toMatch(/<span[^>]*role="img"[^>]*aria-label="private-use glyph sample"|<span[^>]*aria-label="private-use glyph sample"[^>]*role="img"/);
  });

  it('keeps the status line and failure Retry notice', () => {
    const html = render({ open: true, value: 'Gone', discovery: { status: 'success', families: ['Menlo'] } });
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Font is not available on this computer.');
    const failed = render({ open: true, discovery: { status: 'denied' } });
    expect(failed).toContain('role="status"');
    expect(failed).toContain('Retry');
  });
});
