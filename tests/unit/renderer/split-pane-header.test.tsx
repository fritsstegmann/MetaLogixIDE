import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SplitPaneHeader } from '@renderer/components/SplitPaneHeader';

const PATH = '/Users/me/Projects/Personal/acme';
const noop = () => undefined;

function render(opts: { focused?: boolean; actions?: boolean } = {}): string {
  return renderToStaticMarkup(
    <SplitPaneHeader
      label="zsh 2"
      path={PATH}
      focused={opts.focused ?? false}
      dot={<i data-stub="dot" />}
      actions={opts.actions ? { onToTab: noop, onClose: noop } : undefined}
    />,
  );
}

const tags = (html: string, tag: string) => html.match(new RegExp(`<${tag}\\b[^>]*>`, 'g')) ?? [];
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const classes = (tag: string) => (attr(tag, 'class') ?? '').split(' ');
const root = (html: string) => tags(html, 'div')[0] ?? '';
const spans = (html: string) => tags(html, 'span');
const labelTag = (html: string) => spans(html).find((t) => html.indexOf(`${t}zsh 2<`) !== -1) ?? '';
const pathTag = (html: string) => spans(html).find((t) => attr(t, 'title') === PATH) ?? '';
const button = (html: string, testid: string) => tags(html, 'button').find((t) => attr(t, 'data-testid') === testid) ?? '';

describe('SplitPaneHeader', () => {
  it('is the 34px split-pane-header row at 12px with the mockup padding and gap', () => {
    const r = root(render());
    expect(attr(r, 'data-testid')).toBe('split-pane-header');
    expect(classes(r)).toEqual(expect.arrayContaining(['h-[34px]', 'pl-[14px]', 'pr-2', 'gap-2', 'text-[12px]']));
  });

  it('lays out dot, label, path, spacer, then actions', () => {
    const html = render({ actions: true });
    const dot = html.indexOf('data-stub="dot"');
    const label = html.indexOf('>zsh 2<');
    const path = html.indexOf('>~/P/P/acme<');
    const spacer = html.indexOf('flex-1');
    const toTab = html.indexOf('split-to-tab');
    const close = html.indexOf('split-close');
    const order = [dot, label, path, spacer, toTab, close];
    expect(order[0]).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('shows the abbreviated path, full path on hover, muted and truncated', () => {
    const html = render();
    expect(html).toContain('>~/P/P/acme<');
    expect(classes(pathTag(html))).toEqual(expect.arrayContaining(['truncate', 'text-[--text-muted]']));
  });

  it('emphasises the label when focused', () => {
    const html = render({ focused: true });
    expect(classes(labelTag(html))).toEqual(expect.arrayContaining(['font-semibold', 'text-[--text]']));
    expect(classes(root(html))).not.toContain('text-[--text-muted]');
  });

  it('mutes the header and keeps the label regular when not focused', () => {
    const html = render({ focused: false });
    expect(classes(labelTag(html))).toContain('font-normal');
    expect(classes(labelTag(html))).not.toContain('font-semibold');
    expect(classes(root(html))).toContain('text-[--text-muted]');
  });

  it('renders no buttons without actions', () => {
    expect(tags(render(), 'button')).toHaveLength(0);
  });

  it('names "To tab" by its visible text, with no aria-label to diverge from it', () => {
    const html = render({ actions: true });
    const toTab = button(html, 'split-to-tab');
    expect(toTab).not.toBe('');
    expect(attr(toTab, 'aria-label')).toBeUndefined();
    expect(attr(toTab, 'type')).toBe('button');
    const body = html.slice(html.indexOf(toTab), html.indexOf('</button>', html.indexOf(toTab)));
    expect(body).toContain('To tab');
  });

  it('gives the close button the name "Close split" and a 24px radius-6 box', () => {
    const close = button(render({ actions: true }), 'split-close');
    expect(attr(close, 'aria-label')).toBe('Close split');
    expect(attr(close, 'type')).toBe('button');
    expect(classes(close)).toEqual(expect.arrayContaining(['w-6', 'h-6', 'rounded-[6px]']));
  });

  it('matches both focus rings to the 6px button radius and keeps them 24px tall', () => {
    const html = render({ actions: true });
    for (const id of ['split-to-tab', 'split-close']) {
      expect(classes(button(html, id))).toEqual(expect.arrayContaining(['h-6', 'focus-visible:rounded-[6px]']));
    }
  });

  it('hides the To tab icon from assistive technology', () => {
    const html = render({ actions: true });
    const toTab = html.indexOf('split-to-tab');
    const svg = tags(html.slice(toTab), 'svg')[0] ?? '';
    expect(attr(svg, 'aria-hidden')).toBe('true');
  });
});
