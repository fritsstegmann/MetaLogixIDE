/**
 * SplitPill contract (AC1-AC5): labelled "Split" toggle, aria-pressed, constant accessible name,
 * state-dependent tooltip, stable test id on the button itself. Tooltip is mocked to expose its label.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { SplitPill } from '@renderer/components/SplitPill';
import { SPLIT_COPY, SPLIT_TESTIDS } from '@renderer/split-copy';

vi.mock('@renderer/components/Tooltip', () => ({
  Tooltip: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <span data-tooltip={label}>{children}</span>
  ),
}));

const render = (on: boolean) => renderToStaticMarkup(<SplitPill on={on} onToggle={() => {}} />);
const button = (html: string) => /<button\b[^>]*>([\s\S]*?)<\/button>/.exec(html);
const text = (inner: string) => inner.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();

describe('SplitPill', () => {
  it.each([false, true])('is a labelled "Split" button with the toggle test id (on=%s)', (on) => {
    const m = button(render(on));
    expect(m).not.toBeNull();
    expect(m![0]).toContain(`data-testid="${SPLIT_TESTIDS.toggle}"`);
    expect(text(m![1]!)).toBe(SPLIT_COPY.pill);
  });

  it.each([false, true])('reflects state in aria-pressed (on=%s)', (on) => {
    expect(button(render(on))![0]).toContain(`aria-pressed="${on}"`);
  });

  it('keeps its accessible name in both states (no aria-label override)', () => {
    expect(button(render(true))![0]).not.toContain('aria-label');
    expect(button(render(false))![0]).not.toContain('aria-label');
  });

  it('tooltip tells what a click does', () => {
    expect(render(false)).toContain(`data-tooltip="${SPLIT_COPY.tooltipOff}"`);
    expect(render(true)).toContain(`data-tooltip="${SPLIT_COPY.tooltipOn}"`);
  });

  it('is a non-submit button with an accent fill only when on', () => {
    expect(button(render(false))![0]).toContain('type="button"');
    expect(button(render(true))![0]).toMatch(/class="[^"]*bg-\[--accent-soft\]/);
    expect(button(render(false))![0]).not.toMatch(/class="[^"]*bg-\[--accent-soft\]/);
  });
});

describe('ShellTabsBar layout (AC4a)', () => {
  const src = readFileSync('src/renderer/components/ShellTabsBar.tsx', 'utf8');
  it('anchors both new-shell menus to the left edge', () => {
    expect(src).not.toMatch(/absolute top-full right-0/);
    expect(src.match(/absolute top-full left-0/g)).toHaveLength(2);
  });
  it('puts the + button outside the chips scroller, before the pill', () => {
    expect(src.indexOf('tabbar-new-shell')).toBeGreaterThan(src.indexOf('{shells.map'));
    expect(src.indexOf('tabbar-new-shell')).toBeLessThan(src.indexOf('<SplitPill'));
  });
});

describe('SplitPill spec values (AC1, AC3, AC4)', () => {
  it('renders a 13px icon (AC1)', () => {
    const svg = /<svg\b[^>]*>/.exec(render(false))![0];
    expect(svg).toContain('width="13"');
    expect(svg).toContain('height="13"');
  });

  it('uses --accent-soft-text for pressed text, never bare --accent (AC3)', () => {
    const on = button(render(true))![0];
    expect(on).toContain('text-[--accent-soft-text]');
    expect(on).not.toContain('var(--accent)');
  });

  it('insets the strip 14px on the right (AC4)', () => {
    const src = readFileSync('src/renderer/components/ShellTabsBar.tsx', 'utf8');
    expect(src).toMatch(/className="flex items-center gap-1 pl-2 pr-\[14px\] py-1 /);
  });
});
