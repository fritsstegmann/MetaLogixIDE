/**
 * Helpers for the split shell suites (split-shell-cards.spec.ts,
 * motion.spec.ts): opening the split, reading the per-project split state,
 * live shells, and what a pane's terminal shows.
 *
 * A pane's terminal text and shell index are read through React's fiber on
 * the terminal host (the WebGL renderer leaves no DOM text; the technique is
 * the one claude-tab-remount.spec.ts uses).
 */

import { expect, type Page } from '@playwright/test';
import { SPLIT_TESTIDS } from '../../../src/renderer/split-copy';
import { projectIdByName } from './focus';

type Api = { invoke: (c: string, r: unknown) => Promise<never> };

export const RIGHT = `[data-testid="${SPLIT_TESTIDS.right}"]`;
export const LEFT = '.split-left';
/** The row holding both panes (the left pane's parent, per the spec's DOM contract). */
export const ROW = `${LEFT}^`;
/** A strip chip for a shell. */
export const chipSel = (index: number) => `[data-testid="shell-tab-button"][data-shell-index="${index}"]`;

export interface SplitState { activeShellIndex: number; rightShellIndex: number | null; splitRatio?: unknown }

/** The persisted `metaide.projectStates` entry for a project. */
export async function splitState(win: Page, projectId: number): Promise<SplitState | undefined> {
  return win.evaluate((id: number) => {
    const raw = localStorage.getItem('metaide.projectStates');
    if (!raw) return undefined;
    return (JSON.parse(raw) as Record<string, SplitState>)[String(id)];
  }, projectId);
}

/** Clicks the Split pill, waits for the right pane and its fold, and returns the right shell's index. */
export async function openSplit(win: Page, projectName: string): Promise<number> {
  const projectId = await projectIdByName(win, projectName);
  await win.getByTestId(SPLIT_TESTIDS.toggle).click();
  await expect(win.getByTestId(SPLIT_TESTIDS.right)).toBeVisible();
  let idx: number | null = null;
  await expect.poll(async () => { idx = (await splitState(win, projectId))?.rightShellIndex ?? null; return idx; },
    { message: 'the split persists a right shell index' }).not.toBeNull();
  await expect(win.locator(`${RIGHT} .xterm-screen`)).toBeVisible({ timeout: 10000 });
  await waitSettled(win);
  return idx!;
}

/** Waits until no element under the shell area changes width across ~10 consecutive frames. */
export async function waitSettled(win: Page): Promise<void> {
  await win.evaluate(() => new Promise<void>((done) => {
    let last = '';
    let still = 0;
    const read = () => [...document.querySelectorAll('.split-left, [data-testid="split-right"], main, aside')]
      .map((e) => Math.round(e.getBoundingClientRect().width * 10)).join(',')
      + `|${document.querySelectorAll('[data-testid="split-right"]').length}`;
    const tick = () => {
      const now = read();
      still = now === last ? still + 1 : 0;
      last = now;
      if (still >= 10) done();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

/** Shell indices of a project with a live pty. */
export async function aliveIndices(win: Page, projectName: string): Promise<number[]> {
  const projectId = await projectIdByName(win, projectName);
  const { shells } = await win.evaluate(() => (window as unknown as { api: Api }).api
    .invoke('shells:alive-list', undefined) as unknown as Promise<{ shells: Array<{ projectId: number; shellIndex: number }> }>);
  return shells.filter((s) => s.projectId === projectId).map((s) => s.shellIndex).sort((a, b) => a - b);
}

/** Visible lines of the xterm inside `container` (a CSS selector), read from its Terminal instance; null if none. */
export async function paneLines(win: Page, container: string): Promise<string[] | null> {
  return win.evaluate((sel: string) => {
    type Line = { translateToString: (trim: boolean) => string };
    type Term = { rows: number; buffer: { active: { viewportY: number; getLine: (y: number) => Line | undefined } } };
    type Hook = { memoizedState: unknown; next: Hook | null };
    type Fiber = { tag: number; memoizedState: unknown; return: Fiber | null };
    const isTerm = (v: unknown): v is Term =>
      !!v && typeof v === 'object' && 'buffer' in v && 'rows' in v
      && !!(v as { buffer?: { active?: unknown } }).buffer?.active;
    const host = document.querySelector<HTMLElement>(`${sel} .xterm`);
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
    if (!term) return null;
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let r = 0; r < term.rows; r++) lines.push(buf.getLine(buf.viewportY + r)?.translateToString(true) ?? '');
    return lines;
  }, container);
}

/**
 * Starts a per-frame record of which shell index each pane's terminal shows
 * (the `shellIndex` prop of the component owning each `[data-testid="shell-tab"]`),
 * for `ms` milliseconds. Read with `paneShellFrames`.
 */
export async function startPaneShellFrames(win: Page, ms: number): Promise<void> {
  await win.evaluate((ms: number) => {
    type Fiber = { memoizedProps: unknown; return: Fiber | null };
    const indexOf = (host: Element): number | null => {
      const key = Object.keys(host).find((k) => k.startsWith('__reactFiber$'));
      for (let f = key ? (host as unknown as Record<string, Fiber>)[key] ?? null : null; f; f = f.return) {
        const p = f.memoizedProps as { shellIndex?: unknown } | null;
        if (p && typeof p === 'object' && typeof p.shellIndex === 'number') return p.shellIndex;
      }
      return null;
    };
    const w = window as unknown as { __e2ePaneShells: { frames: Array<{ left: number | null; right: number | null }>; done: boolean } };
    const run = { frames: [] as Array<{ left: number | null; right: number | null }>, done: false };
    w.__e2ePaneShells = run;
    const end = performance.now() + ms;
    const tick = () => {
      const l = document.querySelector('.split-left [data-testid="shell-tab"]');
      const r = document.querySelector('[data-testid="split-right"] [data-testid="shell-tab"]');
      run.frames.push({ left: l ? indexOf(l) : null, right: r ? indexOf(r) : null });
      if (performance.now() < end) requestAnimationFrame(tick);
      else run.done = true;
    };
    requestAnimationFrame(tick);
  }, ms);
}

export async function paneShellFrames(win: Page): Promise<Array<{ left: number | null; right: number | null }>> {
  await win.waitForFunction(() => (window as unknown as { __e2ePaneShells?: { done: boolean } }).__e2ePaneShells?.done === true,
    undefined, { timeout: 15000 });
  return win.evaluate(() => (window as unknown as { __e2ePaneShells: { frames: Array<{ left: number | null; right: number | null }> } }).__e2ePaneShells.frames);
}

/** Puts a 1x1 probe with `prop: value` in the document and returns its computed `prop` (resolves tokens the way an element using them would). */
export async function computedFor(win: Page, prop: string, value: string): Promise<string> {
  return win.evaluate(({ prop, value }) => {
    const probe = document.createElement('div');
    probe.style.setProperty(prop, value);
    probe.style.position = 'fixed';
    document.body.appendChild(probe);
    const v = getComputedStyle(probe).getPropertyValue(prop);
    probe.remove();
    return v;
  }, { prop, value });
}
