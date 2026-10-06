import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SIDEBAR_COPY, SIDEBAR_TESTIDS } from '@renderer/sidebar-copy';
import type { Root } from '@shared/types';

vi.mock('@renderer/api', () => ({ api: { invoke: vi.fn() } }));

const { SidebarHeader } = await import('@renderer/components/SidebarHeader');

const noop = async () => undefined;

function render(filter = ''): string {
  return renderToStaticMarkup(
    <SidebarHeader
      filter={filter}
      onFilterChange={() => undefined}
      onNewProject={() => undefined}
      roots={[] as Root[]}
      refreshRoots={noop}
      refreshProjects={noop}
    />,
  );
}

const tags = (html: string, tag: string) => html.match(new RegExp(`<${tag}\\b[^>]*>`, 'g')) ?? [];
const firstTag = (html: string, tag: string) => tags(html, tag)[0] ?? '';
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

describe('SidebarHeader', () => {
  it('renders exactly one filter input with placeholder and accessible name', () => {
    const inputs = tags(render(), 'input');
    expect(inputs).toHaveLength(1);
    expect(attr(firstTag(render(), 'input'), 'placeholder')).toBe(SIDEBAR_COPY.filterPlaceholder);
    expect(attr(firstTag(render(), 'input'), 'aria-label')).toBe(SIDEBAR_COPY.filterLabel);
    expect(attr(firstTag(render(), 'input'), 'data-testid')).toBe(SIDEBAR_TESTIDS.filter);
  });

  it('shows the current filter text', () => {
    expect(attr(firstTag(render('meta'), 'input'), 'value')).toBe('meta');
  });

  it('puts a decorative search icon before the input inside one 36px, 10px-radius field', () => {
    const html = render();
    const label = html.match(/<label\b[^>]*>(.*?)<\/label>/);
    expect(label).not.toBeNull();
    const whole = label?.[0] ?? '';
    const inner = label?.[1] ?? '';
    expect(inner.indexOf('<svg')).toBeGreaterThanOrEqual(0);
    expect(inner.indexOf('<svg')).toBeLessThan(inner.indexOf('<input'));
    expect(attr(firstTag(inner, 'svg'), 'aria-hidden')).toBe('true');
    expect(attr(firstTag(whole, 'label'), 'class')?.split(' ')).toEqual(expect.arrayContaining(['h-9', 'rounded-[10px]']));
  });

  it('renders exactly one button: the 36x36 "+" with accessible name and test id', () => {
    const buttons = tags(render(), 'button');
    expect(buttons).toHaveLength(1);
    const b = firstTag(render(), 'button');
    expect(attr(b, 'aria-label')).toBe(SIDEBAR_COPY.addButtonLabel);
    expect(attr(b, 'data-testid')).toBe(SIDEBAR_TESTIDS.addButton);
    expect(attr(b, 'class')?.split(' ')).toEqual(expect.arrayContaining(['w-9', 'h-9', 'rounded-[10px]']));
  });

  it('announces the "+" as a closed menu button', () => {
    const b = firstTag(render(), 'button');
    expect(attr(b, 'aria-haspopup')).toBe('menu');
    expect(attr(b, 'aria-expanded')).toBe('false');
    expect(render()).not.toContain('data-testid="context-menu"');
  });

  it('has no legacy "+ Root", "+ Project" or rescan controls', () => {
    const html = render();
    for (const gone of ['+ Root', '+ Project', 'sidebar-rescan', 'new-project-btn']) expect(html).not.toContain(gone);
  });
});
