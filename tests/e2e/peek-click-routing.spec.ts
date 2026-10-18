/**
 * Terminal hover preview: a click opens the previewed file in the project it was found in.
 *
 * Fix: 70c8843 fix(peek): open a previewed file in the project it was found in.
 * Unit level: tests/unit/renderer/peek-open.test.ts, hover-preview.test.tsx, main/ipc/register.test.ts.
 *
 * Drives the real Electron app with real ptys (helpers/focus.ts `launch`: mock-claude in shell 0, `/bin/sh` in Terminal
 * tabs). Each test prints a path from a real shell and hovers it with the real mouse at the cell xterm drew it in
 * (helpers/peek-terminal.ts), so detectPaths, ShellTab's link provider, files:peek and HoverPreview all run as shipped.
 *
 * Two projects each hold a `shared.txt` with different content, so "opened the right file" is a content assertion,
 * not a file name assertion.
 *
 * How the card is clicked: the "routing" tests click the card where it stands, without moving the pointer
 * (`clickCardInPlace`). xterm's linkifier fires the link's `leave` as soon as the pointer leaves the path's cells or
 * the terminal element, and ShellTab's `leave` unmounts the card, so moving the pointer onto the card first would test
 * reachability, not routing. Reachability with the real pointer, and clicking the printed path itself, are separate
 * tests at the bottom of the file.
 *
 * "Nothing happens" checks sample state for NOTHING_MS. The same-project test is the positive control: the same click
 * opens the file well inside that window.
 */

import { test, expect, type Page, type ElectronApplication } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, openProject, newShellTab, projectIdByName, projectRow } from './helpers/focus';
import { closeApp, sendLine } from './helpers/claude-harness';
import { hoverPath, pathPoint, previewCard, staysFor } from './helpers/peek-terminal';
import { PEEK_COPY, PEEK_TESTIDS } from '../../src/renderer/peek-open';

const NOTHING_MS = 1500;
const OPEN_TIMEOUT = 10000;
const MAIN_PANE = '.split-left';

interface World {
  app: ElectronApplication;
  win: Page;
  alphaId: number;
  /** Index of alpha's `/bin/sh` tab, active in the Shell tab. */
  sh: number;
  alphaShared: string;
  betaShared: string;
  outsideFile: string;
  content: { alphaShared: string; betaShared: string; alphaHere: string; outside: string };
  cleanup: () => void;
}

/** Launches alpha + beta with the fixture files, opens alpha and a plain shell tab in it. */
async function setup(): Promise<World> {
  const { app, win, demoRoot, cleanup } = await launch(['alpha', 'beta']);
  const outsideDir = mkdtempSync(join(tmpdir(), 'metaide-peek-outside-'));
  const tag = Math.random().toString(36).slice(2, 8);
  const content = {
    alphaShared: `ALPHA-SHARED-${tag}`,
    betaShared: `BETA-SHARED-${tag}`,
    alphaHere: `ALPHA-HERE-${tag}`,
    outside: `OUTSIDE-${tag}`,
  };
  const alphaShared = join(demoRoot, 'alpha', 'shared.txt');
  const betaShared = join(demoRoot, 'beta', 'shared.txt');
  const outsideFile = join(outsideDir, 'outside.txt');
  writeFileSync(alphaShared, `${content.alphaShared}\n`);
  writeFileSync(betaShared, `${content.betaShared}\n`);
  mkdirSync(join(demoRoot, 'alpha', 'src'));
  writeFileSync(join(demoRoot, 'alpha', 'src', 'here.ts'), `export const here = '${content.alphaHere}';\n`);
  writeFileSync(outsideFile, `${content.outside}\n`);
  try {
    await openProject(win, 'alpha');
    const sh = await newShellTab(win, 'alpha');
    const alphaId = await projectIdByName(win, 'alpha');
    return {
      app, win, alphaId, sh, alphaShared, betaShared, outsideFile, content,
      cleanup: () => { cleanup(); rmSync(outsideDir, { recursive: true, force: true }); },
    };
  } catch (e) {
    await closeApp(app);
    cleanup();
    rmSync(outsideDir, { recursive: true, force: true });
    throw e;
  }
}

/** Prints `path` on its own output line in alpha's plain shell. */
async function printPath(w: World, path: string): Promise<void> {
  await sendLine(w.win, w.alphaId, w.sh, `echo '${path}'`);
}

/** Clicks the preview card where it stands, without moving the pointer off the hovered path (see file header). */
async function clickCardInPlace(page: Page): Promise<void> {
  await previewCard(page).dispatchEvent('click');
}

/** Labels of the main window's active tab buttons (Shell / Files / …). */
async function activeMainTabs(win: Page): Promise<string[]> {
  return (await win.locator('button[aria-current="page"]').allInnerTexts()).map((t) => t.trim());
}

/** True iff a sidebar row for `name` carries the selected styling (the row exposes no aria state for selection). */
async function rowSelected(win: Page, name: string): Promise<boolean> {
  const cls = await projectRow(win, name).locator('..').getAttribute('class');
  return (cls ?? '').includes('bg-[--accent-soft]');
}

/** Project, main tab and whether any file preview is open: what a no-op click must leave unchanged. */
async function mainState(win: Page): Promise<{ title: string; shellTab: boolean; filePreviews: number }> {
  return {
    title: await win.title(),
    shellTab: (await activeMainTabs(win)).includes('Shell'),
    filePreviews: await win.getByTestId('file-preview').filter({ visible: true }).count(),
  };
}

const ALPHA_SHELL = { title: 'alpha — MetaLogix IDE', shellTab: true, filePreviews: 0 };

test.describe('terminal hover preview click routing', () => {
  test('a file in the current project previews and a click opens it in this project\'s Files tab', async () => {
    const w = await setup();
    try {
      await printPath(w, 'src/here.ts');
      await hoverPath(w.win, MAIN_PANE, 'src/here.ts');
      const card = previewCard(w.win);
      await expect(card).toHaveAttribute('data-open-action', 'open-here');
      await expect(card).toContainText(w.content.alphaHere);
      await expect(w.win.getByTestId(PEEK_TESTIDS.footer)).toContainText(PEEK_COPY.openHere);
      await expect(w.win.getByTestId(PEEK_TESTIDS.note)).toHaveCount(0);

      const clickedAt = Date.now();
      await clickCardInPlace(w.win);
      await expect(w.win.getByTestId('file-preview').filter({ visible: true })).toContainText(w.content.alphaHere, { timeout: OPEN_TIMEOUT });
      const openedMs = Date.now() - clickedAt;
      expect(openedMs, `positive control: the open lands inside the ${NOTHING_MS} ms no-op window`).toBeLessThan(NOTHING_MS);
      expect(await activeMainTabs(w.win)).toContain('Files');
      expect(await w.win.title()).toBe('alpha — MetaLogix IDE');
      await expect(w.win.getByTestId('file-tab').filter({ visible: true, hasText: 'here.ts' }).first()).toHaveAttribute('aria-selected', 'true');
    } finally {
      await closeApp(w.app);
      w.cleanup();
    }
  });

  test('a file in another project switches to that project and opens that project\'s file, not the same-named one here', async () => {
    const w = await setup();
    try {
      await printPath(w, w.betaShared);
      await hoverPath(w.win, MAIN_PANE, w.betaShared);
      const card = previewCard(w.win);
      await expect(card).toHaveAttribute('data-open-action', 'switch-project');
      await expect(card).toContainText(w.content.betaShared);
      await expect(w.win.getByTestId(PEEK_TESTIDS.footer)).toContainText(PEEK_COPY.switchProject);
      expect(await rowSelected(w.win, 'alpha'), 'alpha is selected before the click').toBe(true);

      await clickCardInPlace(w.win);

      await expect.poll(() => w.win.title(), { timeout: OPEN_TIMEOUT }).toBe('beta — MetaLogix IDE');
      await expect.poll(() => rowSelected(w.win, 'beta'), { message: 'beta is selected in the sidebar' }).toBe(true);
      expect(await rowSelected(w.win, 'alpha'), 'alpha is no longer selected').toBe(false);
      // Opening waits one animation frame after the selection lands (App.tsx openFileInProject).
      const preview = w.win.getByTestId('file-preview').filter({ visible: true });
      await expect(preview, 'beta\'s shared.txt opens after the switch').toContainText(w.content.betaShared, { timeout: OPEN_TIMEOUT });
      await expect(preview).not.toContainText(w.content.alphaShared);
      expect(await activeMainTabs(w.win)).toContain('Files');
      await expect(w.win.getByTestId('file-tab').filter({ visible: true, hasText: 'shared.txt' }).first()).toHaveAttribute('aria-selected', 'true');
    } finally {
      await closeApp(w.app);
      w.cleanup();
    }
  });

  test('a file outside every project previews with a note, and a click does nothing', async () => {
    const w = await setup();
    try {
      await printPath(w, w.outsideFile);
      await hoverPath(w.win, MAIN_PANE, w.outsideFile);
      const card = previewCard(w.win);
      // Positive control: the preview itself rendered the file.
      await expect(card).toContainText(w.content.outside);
      await expect(card).toHaveAttribute('data-open-action', 'disabled');
      await expect(w.win.getByTestId(PEEK_TESTIDS.note)).toHaveText(PEEK_COPY.outsideProjects);
      await expect(w.win.getByTestId(PEEK_TESTIDS.footer)).not.toContainText(PEEK_COPY.openHere);
      expect(await mainState(w.win)).toEqual(ALPHA_SHELL);

      await clickCardInPlace(w.win);

      await staysFor(() => mainState(w.win), ALPHA_SHELL, NOTHING_MS, 'project, tab and Files stay unchanged');
      expect(await rowSelected(w.win, 'alpha')).toBe(true);
    } finally {
      await closeApp(w.app);
      w.cleanup();
    }
  });

  test('in a popout, another project\'s file previews with a note and does nothing; a same-project file still opens', async () => {
    const w = await setup();
    try {
      const [popout] = await Promise.all([
        w.app.waitForEvent('window'),
        w.win.getByTestId('popout-shell').click(),
      ]);
      await popout.waitForLoadState('domcontentloaded');
      await expect(popout.locator('.xterm-screen')).toBeVisible({ timeout: OPEN_TIMEOUT });
      // Wide enough that the absolute temp path prints on one terminal row (a wrapped path is two rows, not one link).
      // Resized after the terminal shows, because the app re-tiles its windows when the popout is first shown.
      await w.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('popout=1'))!.setSize(1400, 700);
      });
      await expect.poll(() => popout.evaluate(() => window.innerWidth), { message: 'popout is resized' }).toBeGreaterThan(1200);
      await expect.poll(() => popout.evaluate(() => document.querySelector('.xterm-screen')!.getBoundingClientRect().width),
        { message: 'popout terminal is refitted' }).toBeGreaterThan(1100);
      await printPath(w, w.betaShared);
      await printPath(w, 'src/here.ts');

      await hoverPath(popout, 'body', w.betaShared);
      const card = previewCard(popout);
      await expect(card).toContainText(w.content.betaShared);
      await expect(card).toHaveAttribute('data-open-action', 'disabled');
      await expect(popout.getByTestId(PEEK_TESTIDS.note)).toHaveText(PEEK_COPY.popoutOtherProject);

      await clickCardInPlace(popout);
      await staysFor(async () => ({
        popoutFilePreviews: await popout.getByTestId('file-preview').filter({ visible: true }).count(),
        mainTitle: await w.win.title(),
      }), { popoutFilePreviews: 0, mainTitle: 'alpha — MetaLogix IDE' }, NOTHING_MS, 'popout stays on Shell and main stays on alpha');

      // Positive control: a same-project file opens in the popout's Files tab.
      await hoverPath(popout, 'body', 'src/here.ts');
      await expect(previewCard(popout)).toHaveAttribute('data-open-action', 'open-here');
      await clickCardInPlace(popout);
      await expect(popout.getByTestId('file-preview').filter({ visible: true })).toContainText(w.content.alphaHere, { timeout: OPEN_TIMEOUT });
      expect(await w.win.title()).toBe('alpha — MetaLogix IDE');
    } finally {
      await closeApp(w.app);
      w.cleanup();
    }
  });

  test('opening a file from the preview adds one Files tab for it, not duplicates', async () => {
    const w = await setup();
    try {
      await printPath(w, 'src/here.ts');
      await hoverPath(w.win, MAIN_PANE, 'src/here.ts');
      await clickCardInPlace(w.win);
      await expect(w.win.getByTestId('file-preview').filter({ visible: true })).toContainText(w.content.alphaHere, { timeout: OPEN_TIMEOUT });
      await staysFor(() => w.win.getByTestId('file-tab').filter({ visible: true, hasText: 'here.ts' }).count(), 1, NOTHING_MS,
        'exactly one Files tab for src/here.ts');
    } finally {
      await closeApp(w.app);
      w.cleanup();
    }
  });

  test.describe('with the real pointer', () => {
    test('moving the pointer from the path onto the card keeps it open, and clicking it opens the file', async () => {
      const w = await setup();
      try {
        await printPath(w, 'src/here.ts');
        // Hover at the top of the row: the card's top edge (pointer + 14 px) then overlaps the path's own row, so the
        // pointer can reach the card without ever crossing a cell outside the path, the most forgiving route there is.
        const at = await hoverPath(w.win, MAIN_PANE, 'src/here.ts', 0.05);
        const box = await previewCard(w.win).boundingBox();
        expect(box, 'the card is laid out').not.toBeNull();
        const onCard = { x: box!.x + 6, y: box!.y + 1 };
        expect(onCard.y, 'the card overlaps the path row, so the route below never leaves the path').toBeLessThan(at.rowTop + at.cellH);
        expect(onCard.x, 'the route stays within the path columns').toBeLessThan(at.x + 4 * at.cellW);
        await w.win.mouse.move(onCard.x, at.y, { steps: 4 });
        await expect(previewCard(w.win), 'moving along the path keeps the card').toBeVisible();
        await w.win.mouse.move(onCard.x, onCard.y, { steps: 2 });
        await staysFor(() => previewCard(w.win).count(), 1, 500, 'the card is still there once the pointer is on it');
        await w.win.mouse.down();
        await w.win.mouse.up();
        await expect(w.win.getByTestId('file-preview').filter({ visible: true })).toContainText(w.content.alphaHere, { timeout: OPEN_TIMEOUT });
      } finally {
        await closeApp(w.app);
        w.cleanup();
      }
    });

    test('clicking another project\'s path in the terminal opens that project\'s file, not the same-named one here', async () => {
      const w = await setup();
      try {
        await printPath(w, w.betaShared);
        const at = await hoverPath(w.win, MAIN_PANE, w.betaShared);
        await expect(previewCard(w.win)).toHaveAttribute('data-open-action', 'switch-project');
        await w.win.mouse.click(at.x, at.y);
        const preview = w.win.getByTestId('file-preview').filter({ visible: true });
        await expect(preview).toBeVisible({ timeout: OPEN_TIMEOUT });
        await expect(preview, 'the opened file is beta\'s shared.txt').toContainText(w.content.betaShared, { timeout: OPEN_TIMEOUT });
        await expect.poll(() => w.win.title(), { timeout: OPEN_TIMEOUT }).toBe('beta — MetaLogix IDE');
      } finally {
        await closeApp(w.app);
        w.cleanup();
      }
    });

    test('clicking a path outside every project in the terminal does nothing', async () => {
      const w = await setup();
      try {
        await printPath(w, w.outsideFile);
        const at = await hoverPath(w.win, MAIN_PANE, w.outsideFile);
        await expect(w.win.getByTestId(PEEK_TESTIDS.note)).toHaveText(PEEK_COPY.outsideProjects);
        expect(await pathPoint(w.win, MAIN_PANE, w.outsideFile), 'the path is still on screen').not.toBeNull();
        await w.win.mouse.click(at.x, at.y);
        await staysFor(() => mainState(w.win), ALPHA_SHELL, NOTHING_MS, 'project, tab and Files stay unchanged');
      } finally {
        await closeApp(w.app);
        w.cleanup();
      }
    });
  });
});
