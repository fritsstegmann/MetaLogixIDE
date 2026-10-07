/**
 * Split shell and sidebar motion.
 *
 * - Opening/closing the split animates the right pane (its container folds
 *   in and out) and never remounts the left terminal — the left pane used to be a
 *   different element in single vs split view, so its xterm was torn down
 *   and replayed on every toggle.
 * - The right pane is fully removed after the exit, and the left pane takes
 *   the full width again.
 * - The sidebar animates when toggled with the mouse, but ⌘B stays instant.
 *
 * Motion is observed by sampling laid-out boxes every animation frame
 * (helpers/frames.ts), so the assertions read what was drawn rather than
 * how an animation was requested.
 */

import { test, expect, _electron as electron, type Page, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SIDEBAR_TESTIDS } from '../../src/renderer/sidebar-copy';
import { sampleDuring, frameLog, type Frame } from './helpers/frames';

type Api = { invoke: (c: string, r: unknown) => Promise<never> };

async function launch(): Promise<{ app: ElectronApplication; win: Page; cleanup: () => void }> {
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  const isolatedHome = mkdtempSync(join(tmpdir(), 'metaide-home-'));
  const demoRoot = mkdtempSync(join(tmpdir(), 'metaide-demo-'));
  mkdirSync(join(demoRoot, 'demo'));
  mkdirSync(join(demoRoot, 'demo', '.git'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(isolatedHome, 'userData')}`],
    env: {
      ...process.env,
      HOME: isolatedHome,
      METAIDE_TEST_MODE: '1',
      METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
      METAIDE_DEFAULT_LAUNCH_FIRST:      JSON.stringify({ argv: ['node', mockClaude],               env: {} }),
      METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: ['node', mockClaude, '--continue'], env: {} }),
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1400, 900); });
  await win.evaluate(async (path: string) => {
    await (window as unknown as { api: Api }).api.invoke('roots:add', { path });
  }, demoRoot);
  await win.getByRole('button', { name: 'demo', exact: true }).click();
  await expect(win.locator('[data-testid="shell-tab"] .xterm-screen')).toBeVisible({ timeout: 10000 });
  return {
    app, win,
    cleanup: () => {
      rmSync(isolatedHome, { recursive: true, force: true });
      rmSync(demoRoot, { recursive: true, force: true });
    },
  };
}

/** The first four ancestors of `split-right`, nearest first, as frame targets (`animatedLevels` drops the row and above). */
const ANCESTORS = { a1: '[data-testid="split-right"]^', a2: '[data-testid="split-right"]^^', a3: '[data-testid="split-right"]^^^', a4: '[data-testid="split-right"]^^^^' };
const LEVELS = ['a1', 'a2', 'a3', 'a4'] as const;

/** Levels whose element is inside the pane row and whose width moved through intermediate values in the frames. */
async function animatedLevels(win: Page, frames: Frame[]): Promise<Array<{ level: number; firstTestid: string | null }>> {
  const facts = await win.evaluate(() => {
    const right = document.querySelector('[data-testid="split-right"]');
    const row = document.querySelector('.split-left')!.parentElement!;
    const out: Array<{ insideRow: boolean; firstTestid: string | null }> = [];
    let el = right?.parentElement ?? null;
    for (let i = 0; i < 4; i++) {
      out.push({ insideRow: !!el && el !== row && row.contains(el), firstTestid: el?.querySelector('[data-testid]')?.getAttribute('data-testid') ?? null });
      el = el?.parentElement ?? null;
    }
    return out;
  });
  return LEVELS.flatMap((k, i) => {
    const ws = frames.filter((f) => f.s[k]!.present).map((f) => Math.round(f.s[k]!.w));
    const varied = new Set(ws).size >= 3;
    return facts[i]!.insideRow && varied ? [{ level: i + 1, firstTestid: facts[i]!.firstTestid }] : [];
  });
}

test('split open/close animates the right pane and keeps the left terminal mounted', async () => {
  const { app, win, cleanup } = await launch();
  try {
    const shellTabs = win.locator('[data-testid="shell-tab"]');
    await expect(shellTabs).toHaveCount(1);
    // Tag the left terminal element; a remount would drop the tag.
    await win.evaluate(() => {
      (document.querySelector('[data-testid="shell-tab"] .xterm') as HTMLElement & { __leftTag?: boolean }).__leftTag = true;
    });

    const opening = await sampleDuring(win, ANCESTORS, 1500, () => win.getByTestId('tabbar-split').click());
    await expect(win.getByTestId('split-right')).toBeVisible();
    await expect(shellTabs).toHaveCount(2);
    const animated = await animatedLevels(win, opening);
    expect(animated.length, `split open animates a container around the right pane\n${frameLog(opening, LEVELS.map((k) => [k, 'w']))}`).toBeGreaterThan(0);
    for (const a of animated) {
      expect(a.firstTestid, `first data-testid inside the animated container (ancestor ${a.level})`).toBe('split-right');
    }

    const leftKept = () => win.evaluate(() =>
      (document.querySelector('[data-testid="shell-tab"] .xterm') as HTMLElement & { __leftTag?: boolean } | null)?.__leftTag === true);
    expect(await leftKept(), 'left terminal survives opening the split').toBe(true);

    const closing = await sampleDuring(win, { ...ANCESTORS, right: '[data-testid="split-right"]' }, 1500, () => win.getByTestId('tabbar-split').click());
    await expect(win.getByTestId('split-right')).toHaveCount(0);
    await expect(shellTabs).toHaveCount(1);
    const outW = closing.filter((f) => f.s.right!.present).map((f) => Math.round(f.s.a2!.w));
    expect(new Set(outW).size, `split close animates the right pane out\n${frameLog(closing, [['a2', 'w'], ['right', 'present']])}`).toBeGreaterThanOrEqual(3);
    expect(await leftKept(), 'left terminal survives closing the split').toBe(true);

    // Left pane fills the row again once the right pane is gone.
    const widths = await win.evaluate(() => {
      const left = document.querySelector('.split-left')!.getBoundingClientRect().width;
      const row = document.querySelector('.split-left')!.parentElement!.getBoundingClientRect().width;
      return { left, row };
    });
    expect(Math.abs(widths.left - widths.row)).toBeLessThan(1);
  } finally {
    await app.close();
    cleanup();
  }
});

test('sidebar animates on click but toggles instantly from the keyboard', async () => {
  const { app, win, cleanup } = await launch();
  try {
    const sidebar = win.getByTestId(SIDEBAR_TESTIDS.addButton);
    await expect(sidebar).toBeVisible();
    const positions = (frames: Frame[]) => new Set(frames.map((f) => Math.round(f.s.main!.x * 10) / 10)).size;

    const hide = await sampleDuring(win, { main: 'main' }, 1000, () => win.getByTestId('ab-toggle-sidebar').click());
    await expect(sidebar).toHaveCount(0);
    const show = await sampleDuring(win, { main: 'main' }, 1000, () => win.getByTestId('ab-toggle-sidebar').click());
    await expect(sidebar).toBeVisible();
    expect(positions(hide), `click hide animates (main passes through intermediate positions)\n${frameLog(hide, [['main', 'x']])}`).toBeGreaterThanOrEqual(4);
    expect(positions(show), `click show animates\n${frameLog(show, [['main', 'x']])}`).toBeGreaterThanOrEqual(4);

    await win.getByTestId('activity-bar').click({ position: { x: 20, y: 400 } }); // move focus out of the terminal
    const keyHide = await sampleDuring(win, { main: 'main' }, 600, () => win.keyboard.press('ControlOrMeta+b'));
    await expect(sidebar).toHaveCount(0);
    const keyShow = await sampleDuring(win, { main: 'main' }, 600, () => win.keyboard.press('ControlOrMeta+b'));
    await expect(sidebar).toBeVisible();
    expect(positions(keyHide), `⌘B never animates (two positions, nothing between)\n${frameLog(keyHide, [['main', 'x']])}`).toBe(2);
    expect(positions(keyShow), `⌘B never animates (two positions, nothing between)\n${frameLog(keyShow, [['main', 'x']])}`).toBe(2);
  } finally {
    await app.close();
    cleanup();
  }
});
