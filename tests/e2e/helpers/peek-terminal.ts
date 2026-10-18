/**
 * Helpers for driving terminal hover previews (peek-click-routing.spec.ts).
 *
 * Terminal text is canvas/WebGL-rendered, so a printed path has no DOM node to
 * hover. These helpers read the xterm Terminal instance through React's fiber
 * (the technique split.ts and terminal-probe.ts use) to find which cell a path
 * sits in, then move the real mouse to that cell. xterm's linkifier listens to
 * DOM mousemove on `.xterm-screen`, so the real pointer exercises the whole
 * production chain: detectPaths, the link provider in ShellTab, files:peek and
 * HoverPreview.
 */

import { expect, type Locator, type Page } from '@playwright/test';
import { PEEK_TESTIDS } from '../../../src/renderer/peek-open';

/** Client coordinates of a point in a terminal cell, plus the cell size. */
export interface CellPoint { x: number; y: number; cellW: number; cellH: number; rowTop: number }

/**
 * Locates the last visible line of the terminal inside `container` whose trimmed text is exactly `needle`, and returns
 * the client point in the middle column of that text. `rowFraction` picks the height inside the row (0 = top edge,
 * 0.5 = middle). Null when no such line is on screen yet.
 */
export async function pathPoint(page: Page, container: string, needle: string, rowFraction = 0.5): Promise<CellPoint | null> {
  return page.evaluate(({ sel, needle, rowFraction }) => {
    type Line = { translateToString: (trim: boolean) => string };
    type Term = { cols: number; rows: number; buffer: { active: { viewportY: number; getLine: (y: number) => Line | undefined } } };
    type Hook = { memoizedState: unknown; next: Hook | null };
    type Fiber = { tag: number; memoizedState: unknown; return: Fiber | null };
    const isTerm = (v: unknown): v is Term =>
      !!v && typeof v === 'object' && 'buffer' in v && 'cols' in v && 'rows' in v
      && !!(v as { buffer?: { active?: unknown } }).buffer?.active;
    const host = [...document.querySelectorAll<HTMLElement>(`${sel} .xterm`)].find((n) => n.offsetParent !== null);
    if (!host) return null;
    let el: HTMLElement | null = host;
    let fiber: Fiber | null = null;
    while (el && !fiber) {
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      if (key) fiber = (el as unknown as Record<string, Fiber>)[key] ?? null;
      el = el.parentElement;
    }
    let term: Term | null = null;
    for (let f = fiber; f && !term; f = f.return) {
      if (f.tag !== 0) continue;
      for (let h = f.memoizedState as Hook | null; h && !term; h = h.next) {
        const ref = h.memoizedState as { current?: unknown } | null;
        if (ref && typeof ref === 'object' && 'current' in ref && isTerm(ref.current)) term = ref.current;
      }
    }
    const screen = host.querySelector<HTMLElement>('.xterm-screen');
    if (!term || !screen) return null;
    const rect = screen.getBoundingClientRect();
    const cellW = rect.width / term.cols;
    const cellH = rect.height / term.rows;
    const buf = term.buffer.active;
    for (let r = term.rows - 1; r >= 0; r--) {
      const text = buf.getLine(buf.viewportY + r)?.translateToString(true) ?? '';
      if (text.trim() !== needle) continue;
      const col = text.indexOf(needle) + Math.floor(needle.length / 2);
      const rowTop = rect.top + r * cellH;
      return { x: rect.left + (col + 0.5) * cellW, y: rowTop + rowFraction * cellH, cellW, cellH, rowTop };
    }
    return null;
  }, { sel: container, needle, rowFraction });
}

/** The hover preview card in `page`. */
export function previewCard(page: Page): Locator {
  return page.getByTestId(PEEK_TESTIDS.card);
}

/**
 * Hovers the printed `needle` in the terminal inside `container` with the real mouse and waits until the preview card
 * has finished loading a found file (its footer renders only then). Moves the pointer off the terminal first so each
 * attempt is a fresh hover. Returns the point hovered.
 */
export async function hoverPath(page: Page, container: string, needle: string, rowFraction = 0.5): Promise<CellPoint> {
  let point: CellPoint | null = null;
  await expect(async () => {
    point = await pathPoint(page, container, needle, rowFraction);
    expect(point, `"${needle}" is on screen in ${container}`).not.toBeNull();
    await page.mouse.move(2, 2);
    await page.mouse.move(point!.x - point!.cellW, point!.y);
    await page.mouse.move(point!.x, point!.y, { steps: 2 });
    await expect(page.getByTestId(PEEK_TESTIDS.footer)).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
  return point!;
}

/**
 * Samples `read` for `ms` milliseconds and fails on the first sample that differs from `expected`. For "nothing
 * happened" assertions, which have no event to wait on; callers pair it with a positive control showing the same
 * window is long enough for the action to have taken effect.
 */
export async function staysFor<T>(read: () => Promise<T>, expected: T, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const actual: unknown = await read();
    expect(actual, what).toEqual(expected);
    await new Promise((r) => setTimeout(r, 100));
  }
}
