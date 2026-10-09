import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FONT_COPY, FONT_TEST_IDS, TERMINAL_FONT_WEIGHT_NAMES } from '../../src/renderer/fonts/font-contract';
import { TERMINAL_FONT_WEIGHTS, terminalBoldWeight } from '../../src/shared/terminal-font-weight';
import {
  terminalProbes,
  installInvokeRecorder,
  invokeCalls,
  installFailingHandler,
  restoreHandler,
} from './helpers/terminal-probe';

/**
 * Terminal font weight setting (docs/specs/terminal-font-weight.md, AC1-AC14).
 *
 * Authored against the Setup-contract commit (b910608): `FONT_TEST_IDS.terminalWeightSelect`,
 * `FONT_COPY.terminalWeight*` and `TERMINAL_FONT_WEIGHT_NAMES` in
 * `src/renderer/fonts/font-contract.ts`; `TERMINAL_FONT_WEIGHTS`, `TERMINAL_FONT_WEIGHT_DEFAULT`
 * and `terminalBoldWeight` in `src/shared/terminal-font-weight.ts`; the IPC channel
 * `settings:set-terminal-font-weight` in `src/shared/ipc-contract.ts`; and the settings key
 * `terminal_font_weight`. `TerminalFontWeightControl.tsx`, the store, the context and the live
 * apply in `ShellTab.tsx` do not exist yet at authoring time (Agent 2's slice) — this suite
 * exercises them only through the real surface (the `<select>`, the IPC channel, the settings
 * store, the xterm probe), per the plan's §7 E2E checklist, mirroring
 * `terminal-font-size.spec.ts`'s harness and probing conventions.
 */

const PROJECT = 'terminal-weight-e2e';
const E2E_TIMEOUT = 10_000;
const CHANNEL = 'settings:set-terminal-font-weight';
const SETTING_KEY = 'terminal_font_weight';
const DEFAULT = 400;
const DEFAULT_BOLD = 700;

type Api = { invoke: (channel: string, request: unknown) => Promise<unknown> };
type RendererWindow = Window & { api: Api };

interface Harness {
  app: ElectronApplication;
  win: Page;
  home: string;
  root: string;
  projectDir: string;
  close: (remove?: boolean) => Promise<void>;
}

function createFixture(): { home: string; root: string; projectDir: string } {
  const home = mkdtempSync(join(tmpdir(), 'metaide-termweight-home-'));
  const root = mkdtempSync(join(tmpdir(), 'metaide-termweight-root-'));
  const projectDir = join(root, PROJECT);
  mkdirSync(projectDir);
  mkdirSync(join(projectDir, '.git'));
  writeFileSync(join(projectDir, 'placeholder.txt'), 'terminal font weight E2E fixture\n');
  return { home, root, projectDir };
}

async function launchHarness(
  fixture = createFixture(),
  options: { addRoot?: boolean } = {},
): Promise<Harness> {
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(fixture.home, 'userData')}`],
    env: {
      ...process.env,
      HOME: fixture.home,
      SHELL: '/bin/sh',
      METAIDE_TEST_MODE: '1',
      METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
      METAIDE_DEFAULT_LAUNCH_FIRST: JSON.stringify({ argv: ['node', mockClaude], env: {} }),
      METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: ['node', mockClaude, '--continue'], env: {} }),
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1400, 900));
  if (options.addRoot !== false) {
    await win.evaluate(async (path: string) => {
      const rendererWindow = window as unknown as RendererWindow;
      await rendererWindow.api.invoke('roots:add', { path });
    }, fixture.root);
  }
  return {
    app,
    win,
    ...fixture,
    close: async (remove = true) => {
      await app.close();
      if (remove) {
        rmSync(fixture.home, { recursive: true, force: true });
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  };
}

async function openProject(win: Page): Promise<void> {
  const project = win.getByTestId('project-row')
    .filter({ has: win.getByText(PROJECT, { exact: true }) })
    .first();
  await expect(project).toBeVisible({ timeout: E2E_TIMEOUT });
  await project.click();
  await expect(win.locator('[data-testid="shell-tab"] .xterm-screen')).toBeVisible({ timeout: E2E_TIMEOUT });
}

async function openSettings(win: Page): Promise<void> {
  await win.getByTestId('settings-open').click();
  await expect(win.getByTestId('settings-modal')).toBeVisible();
}

async function closeSettings(win: Page): Promise<void> {
  await win.getByTestId('settings-done').click();
  await expect(win.getByTestId('settings-modal')).toHaveCount(0);
}

function weightSelect(win: Page) {
  return win.getByTestId(FONT_TEST_IDS.terminalWeightSelect);
}

async function storedWeight(win: Page): Promise<number | null> {
  return win.evaluate(async (key: string) => {
    const rendererWindow = window as unknown as RendererWindow;
    const response = await rendererWindow.api.invoke('settings:get', { key }) as { value: number | null };
    return response.value;
  }, SETTING_KEY);
}

/**
 * Forces the WebGL addon's context to be lost so `webgl.onContextLoss` disposes it
 * (ShellTab.tsx), which — per the plan's scout research (addon-webgl's dispose
 * disposable calling `_renderService.setRenderer(_createRenderer())`) — makes xterm
 * fall back to its default DOM renderer. Finds the live WebGL context the same way a
 * real driver crash would surface it: by asking each canvas inside the xterm node for
 * its *already-created* context (`getContext` is idempotent per canvas/type and does
 * not create a new one), not by creating a fresh context of our own.
 */
async function loseWebglContext(win: Page): Promise<boolean> {
  return win.evaluate(() => {
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>('.xterm canvas')];
    for (const canvas of canvases) {
      const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
      const ext = gl?.getExtension('WEBGL_lose_context');
      if (ext) {
        ext.loseContext();
        return true;
      }
    }
    return false;
  });
}

test.describe.serial('terminal font weight setting', () => {
  test('AC1, AC3, AC12: Settings shows the control after Terminal font size, at the default, with nine labelled options, exact hint, keyboard reachable', async () => {
    const harness = await launchHarness();
    try {
      const { win } = harness;
      await openProject(win);

      // AC3: nothing is written to the store just by launching the app.
      expect(await storedWeight(win)).toBeNull();
      const firstProbe = (await terminalProbes(win))[0];
      if (!firstProbe) throw new Error('terminal probe unavailable');
      expect(firstProbe.fontWeight).toBe(DEFAULT);
      expect(firstProbe.fontWeightBold).toBe(DEFAULT_BOLD);

      await openSettings(win);
      const select = weightSelect(win);
      // AC12: accessible name is exactly "Terminal font weight".
      await expect(select).toHaveAccessibleName(FONT_COPY.terminalWeightLabel);
      expect(FONT_COPY.terminalWeightLabel).toBe('Terminal font weight');
      await expect(select).toHaveValue(String(DEFAULT));

      // AC1: exactly nine options, in order, each labelled "Name (W)".
      const options = select.locator('option');
      await expect(options).toHaveCount(TERMINAL_FONT_WEIGHTS.length);
      for (const [index, weight] of TERMINAL_FONT_WEIGHTS.entries()) {
        const option = options.nth(index);
        await expect(option).toHaveAttribute('value', String(weight));
        await expect(option).toHaveText(`${TERMINAL_FONT_WEIGHT_NAMES[weight]} (${weight})`);
      }
      expect(FONT_COPY.terminalWeightOptionLabel(500)).toBe('Medium (500)');

      // AC1: exact hint text.
      await expect(win.getByText(FONT_COPY.terminalWeightHint, { exact: true })).toBeVisible();
      expect(FONT_COPY.terminalWeightHint).toBe(
        'Bold text is drawn 200 heavier, from 700 up to 900. Fonts without this weight use the nearest one.',
      );

      // AC1: directly after the Terminal font size input.
      const sizeInput = win.getByTestId(FONT_TEST_IDS.terminalSizeInput);
      const sizeBox = await sizeInput.boundingBox();
      const selectBox = await select.boundingBox();
      if (!sizeBox || !selectBox) throw new Error('font row geometry unavailable');
      expect(selectBox.y).toBeGreaterThan(sizeBox.y);

      // AC12: Tab from the size control reaches the weight select next.
      await sizeInput.focus();
      await win.keyboard.press('Tab');
      await expect(select, 'Tab from Terminal font size lands on Terminal font weight').toBeFocused();

      // AC12: selecting a value through the real control applies it.
      await select.selectOption(String(500));
      await expect.poll(() => storedWeight(win), { timeout: E2E_TIMEOUT }).toBe(500);
      await expect.poll(async () => (await terminalProbes(win))[0]?.fontWeight, { timeout: E2E_TIMEOUT }).toBe(500);
    } finally {
      await harness.close();
    }
  });

  test('AC2: choosing the already-selected value saves nothing; a genuine change does', async () => {
    const harness = await launchHarness();
    try {
      const { app, win } = harness;
      await openProject(win);
      await openSettings(win);
      const select = weightSelect(win);
      await expect(select).toHaveValue(String(DEFAULT));

      await installInvokeRecorder(app, CHANNEL);
      const baseline = (await invokeCalls(app, CHANNEL)).length;
      await select.selectOption(String(DEFAULT));
      expect(await invokeCalls(app, CHANNEL), 're-selecting the current value issues no save').toHaveLength(baseline);
      expect(await storedWeight(win)).toBeNull();

      // Positive control: a real change does save.
      await select.selectOption(String(600));
      expect(await invokeCalls(app, CHANNEL), 'a genuine change saves immediately').toHaveLength(baseline + 1);
      await expect.poll(() => storedWeight(win), { timeout: E2E_TIMEOUT }).toBe(600);
    } finally {
      await harness.close();
    }
  });

  test('AC4: bold is derived as min(W + 300, 900) for every one of the nine weights', async () => {
    const harness = await launchHarness();
    try {
      const { win } = harness;
      await openProject(win);
      await openSettings(win);
      const select = weightSelect(win);

      for (const weight of TERMINAL_FONT_WEIGHTS) {
        await select.selectOption(String(weight));
        await expect.poll(() => storedWeight(win), { timeout: E2E_TIMEOUT }).toBe(weight);
        const expectedBold = terminalBoldWeight(weight);
        await expect.poll(async () => (await terminalProbes(win))[0]?.fontWeight, { timeout: E2E_TIMEOUT }).toBe(weight);
        expect((await terminalProbes(win))[0]?.fontWeightBold).toBe(expectedBold);
      }
      // Table-driven corners named explicitly, matching the spec's own examples:
      // 100-500 -> 700, 600 -> 800, 700-900 -> 900.
      expect(terminalBoldWeight(100)).toBe(700);
      expect(terminalBoldWeight(500)).toBe(700);
      expect(terminalBoldWeight(600)).toBe(800);
      expect(terminalBoldWeight(700)).toBe(900);
      expect(terminalBoldWeight(900)).toBe(900);
    } finally {
      await harness.close();
    }
  });

  test('AC5, AC6, AC11: a Settings change live-applies to every open terminal without recreating it, and a later shell opens at the new weight', async () => {
    const harness = await launchHarness();
    try {
      const { app, win } = harness;
      await openProject(win);
      await win.getByTestId('tabbar-split').click();
      await expect(win.getByTestId('split-right').locator('.xterm')).toBeVisible({ timeout: E2E_TIMEOUT });
      const poppedShell = await win.evaluate(async (projectName) => {
        const rendererWindow = window as unknown as RendererWindow;
        const { projects } = await rendererWindow.api.invoke('projects:list', undefined) as {
          projects: Array<{ id: number; name: string }>;
        };
        const project = projects.find((p) => p.name === projectName);
        if (!project) throw new Error('project unavailable');
        const { shellIndex } = await rendererWindow.api.invoke('shells:launch-plain', { projectId: project.id }) as { shellIndex: number };
        return { projectId: project.id, shellIndex };
      }, PROJECT);
      const [popout] = await Promise.all([
        app.waitForEvent('window'),
        win.evaluate(async (request) => {
          const rendererWindow = window as unknown as RendererWindow;
          await rendererWindow.api.invoke('windows:popout-shell', request);
        }, poppedShell),
      ]);
      await popout.waitForLoadState('domcontentloaded');
      await expect(popout.locator('.xterm')).toBeVisible({ timeout: E2E_TIMEOUT });

      const mainBefore = await terminalProbes(win);
      const popoutBefore = await terminalProbes(popout);
      expect(mainBefore).toHaveLength(2);
      expect(popoutBefore).toHaveLength(1);

      await openSettings(win);
      await weightSelect(win).selectOption(String(900));
      await closeSettings(win);

      // AC5: live-applies everywhere, same identity tokens, buffer/cols/rows untouched (not recreated).
      await expect.poll(async () => (await terminalProbes(win)).map((p) => p.fontWeight), { timeout: E2E_TIMEOUT }).toEqual([900, 900]);
      await expect.poll(async () => (await terminalProbes(popout))[0]?.fontWeight, { timeout: E2E_TIMEOUT }).toBe(900);
      const mainAfter = await terminalProbes(win);
      const popoutAfter = await terminalProbes(popout);
      expect(mainAfter.map((p) => p.token)).toEqual(mainBefore.map((p) => p.token));
      expect(popoutAfter.map((p) => p.token)).toEqual(popoutBefore.map((p) => p.token));
      expect(mainAfter.map((p) => ({ cols: p.cols, rows: p.rows }))).toEqual(mainBefore.map((p) => ({ cols: p.cols, rows: p.rows })));
      expect(mainAfter.map((p) => p.bufferLength)).toEqual(mainBefore.map((p) => p.bufferLength));
      expect(popoutAfter[0]?.fontWeightBold).toBe(900);

      // AC13: untouched by the weight change.
      expect(mainAfter.map((p) => p.fontSize)).toEqual(mainBefore.map((p) => p.fontSize));
      expect(mainAfter.map((p) => p.fontFamily)).toEqual(mainBefore.map((p) => p.fontFamily));

      // AC6, AC11: a shell not mounted at change time opens at the current weight,
      // and that applies through to a second popped-out window too.
      const launched = await win.evaluate(async (projectName) => {
        const rendererWindow = window as unknown as RendererWindow;
        const { projects } = await rendererWindow.api.invoke('projects:list', undefined) as {
          projects: Array<{ id: number; name: string }>;
        };
        const project = projects.find((p) => p.name === projectName);
        if (!project) throw new Error('project unavailable');
        const { shellIndex } = await rendererWindow.api.invoke('shells:launch-plain', { projectId: project.id }) as { shellIndex: number };
        return { projectId: project.id, shellIndex };
      }, PROJECT);
      const [secondPopout] = await Promise.all([
        app.waitForEvent('window'),
        win.evaluate(async (request) => {
          const rendererWindow = window as unknown as RendererWindow;
          await rendererWindow.api.invoke('windows:popout-shell', request);
        }, launched),
      ]);
      await secondPopout.waitForLoadState('domcontentloaded');
      await expect(secondPopout.locator('.xterm')).toBeVisible({ timeout: E2E_TIMEOUT });
      const secondProbe = (await terminalProbes(secondPopout))[0];
      expect(secondProbe?.fontWeight, 'opens at the current weight, not the default').toBe(900);
      expect(secondProbe?.fontWeightBold).toBe(900);
      await secondPopout.close();
    } finally {
      await harness.close();
    }
  });

  test('AC5: already-rendered text repaints at the new weight with no new output, under WebGL and under the DOM fallback', async () => {
    const harness = await launchHarness();
    try {
      const { win } = harness;
      await openProject(win);

      // Put real glyphs on screen (no further output after this), using the
      // default font stack's first available face (SF Mono / Menlo on macOS CI),
      // which has visually distinct Regular and Black faces.
      await win.locator('.xterm').first().click();
      await win.keyboard.type('WEIGHT REPAINT 0123456789');
      await expect.poll(async () => (await terminalProbes(win))[0]?.screen, { timeout: E2E_TIMEOUT })
        .toContain('WEIGHT REPAINT 0123456789');

      const host = win.locator('[data-testid="shell-tab"] .xterm-screen').first();
      await expect(host).toBeVisible();

      // WebGL path: screenshot at 400, change to 900 with no new output or scroll, screenshot again.
      const beforeWebgl = await host.screenshot();
      await openSettings(win);
      await weightSelect(win).selectOption(String(900));
      await closeSettings(win);
      await expect.poll(async () => (await terminalProbes(win))[0]?.fontWeight, { timeout: E2E_TIMEOUT }).toBe(900);
      const afterWebgl = await host.screenshot();
      expect(Buffer.compare(beforeWebgl, afterWebgl), 'WebGL: the repaint changes the rendered pixels with no new output').not.toBe(0);

      // DOM fallback path: lose the WebGL context so the addon disposes and xterm
      // falls back to its DOM renderer, back the weight off to 400, then verify the
      // DOM renderer's own row styling reflects the new weight with no new output.
      const lostContext = await loseWebglContext(win);
      expect(lostContext, 'a live WebGL context was found to force-lose').toBe(true);
      await openSettings(win);
      await weightSelect(win).selectOption(String(400));
      await closeSettings(win);
      await expect.poll(async () => (await terminalProbes(win))[0]?.fontWeight, { timeout: E2E_TIMEOUT }).toBe(400);
      const beforeDom = await host.screenshot();
      await openSettings(win);
      await weightSelect(win).selectOption(String(900));
      await closeSettings(win);
      await expect.poll(async () => (await terminalProbes(win))[0]?.fontWeight, { timeout: E2E_TIMEOUT }).toBe(900);
      const rowWeight = await win.evaluate(() => {
        const row = document.querySelector('.xterm-rows > div');
        return row ? getComputedStyle(row).fontWeight : null;
      });
      expect(rowWeight, 'the DOM fallback renderer writes the new weight onto its rows').toBe('900');
      const afterDom = await host.screenshot();
      expect(Buffer.compare(beforeDom, afterDom), 'DOM fallback: the repaint changes the rendered pixels with no new output').not.toBe(0);
    } finally {
      await harness.close();
    }
  });

  test('AC7, AC8: the weight survives a restart with no visible extra jump; the dedicated setter and the generic channel both reject an invalid value', async () => {
    const fixture = createFixture();
    let harness = await launchHarness(fixture);
    try {
      await openProject(harness.win);
      await openSettings(harness.win);
      await weightSelect(harness.win).selectOption(String(800));
      await expect.poll(() => storedWeight(harness.win), { timeout: E2E_TIMEOUT }).toBe(800);
      await closeSettings(harness.win);
      await harness.close(false);

      harness = await launchHarness(fixture, { addRoot: false });
      expect(await storedWeight(harness.win)).toBe(800);
      await openProject(harness.win);
      const firstProbe = (await terminalProbes(harness.win))[0];
      if (!firstProbe) throw new Error('terminal probe unavailable after restart');
      expect(firstProbe.fontWeight, 'terminals open at the saved weight, no visible 400-then-800 jump').toBe(800);
      expect(firstProbe.fontWeightBold).toBe(900);

      // AC8: the dedicated setter rejects out-of-set values and leaves the stored value unchanged.
      for (const invalid of [450, 1000, 0, 'bold', null]) {
        await expect(harness.win.evaluate(async (value) => {
          const rendererWindow = window as unknown as RendererWindow;
          await rendererWindow.api.invoke('settings:set-terminal-font-weight', { value });
        }, invalid)).rejects.toThrow();
        expect(await storedWeight(harness.win), `value ${String(invalid)} must not change the stored weight`).toBe(800);
      }

      // AC8: the generic settings:set channel rejects the key too, so validation cannot be bypassed.
      await expect(harness.win.evaluate(async () => {
        const rendererWindow = window as unknown as RendererWindow;
        await rendererWindow.api.invoke('settings:set', { key: 'terminal_font_weight', value: 500 });
      })).rejects.toThrow();
      expect(await storedWeight(harness.win)).toBe(800);
    } finally {
      await harness.close();
    }
  });

  test('AC9: an invalid stored weight falls back to 400, is logged, and is not silently rewritten', async () => {
    const fixture = createFixture();
    // Seed the store with a hand-edited, invalid value before the app ever reads it.
    // The generic `settings:set` channel is itself guarded against this key (AC8), so
    // there is no first-party IPC path to write an invalid weight — seed directly
    // through sqlite, the same way a user's hand-edit would land.
    const firstRun = await launchHarness(fixture);
    await openProject(firstRun.win);
    await firstRun.close(false);

    // `buildServices` (src/main/services.ts) resolves the DB at
    // `<homeDir>/.metaide/metaide.db`, and the harness points HOME at
    // `fixture.home` (not Electron's own `--user-data-dir`), so that is where
    // the running app's settings actually live.
    const Database = (await import('better-sqlite3')).default;
    const dbPath = join(fixture.home, '.metaide', 'metaide.db');
    const db = new Database(dbPath);
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('450', SETTING_KEY);
    db.close();

    const consoleErrors: string[] = [];
    const harness = await launchHarness(fixture, { addRoot: false });
    harness.win.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    try {
      await openProject(harness.win);
      const probe = (await terminalProbes(harness.win))[0];
      expect(probe?.fontWeight, 'an invalid stored weight falls back to 400 for terminals').toBe(400);
      expect(probe?.fontWeightBold).toBe(700);
      await openSettings(harness.win);
      await expect(weightSelect(harness.win)).toHaveValue(String(400));
      await closeSettings(harness.win);
      expect(await storedWeight(harness.win), 'the invalid stored value is not silently rewritten').toBe(450);
      await expect.poll(() => consoleErrors.length, { timeout: E2E_TIMEOUT }).toBeGreaterThan(0);
    } finally {
      await harness.close();
    }
  });

  test('AC10: a failed save reverts the control and every terminal to the stored weight and shows the exact error toast', async () => {
    const harness = await launchHarness();
    try {
      const { app, win } = harness;
      await openProject(win);
      await win.getByTestId('tabbar-split').click();
      await expect(win.getByTestId('split-right').locator('.xterm')).toBeVisible({ timeout: E2E_TIMEOUT });
      expect(await storedWeight(win)).toBeNull();
      await expect.poll(async () => (await terminalProbes(win)).map((p) => p.fontWeight)).toEqual([DEFAULT, DEFAULT]);

      await installFailingHandler(app, CHANNEL, 'injected terminal font weight save failure');
      await installInvokeRecorder(app, CHANNEL);
      try {
        await openSettings(win);
        const select = weightSelect(win);
        await select.selectOption(String(600));
        await expect(
          win.getByTestId('toast').filter({ hasText: FONT_COPY.terminalWeightSaveFailed }).first(),
          'positive control: the failure toast appeared',
        ).toBeVisible({ timeout: E2E_TIMEOUT });
        expect(FONT_COPY.terminalWeightSaveFailed).toBe(
          'Could not save the terminal font weight. Your previous weight remains active.',
        );
        await expect(select, 'the control reverts to the stored weight').toHaveValue(String(DEFAULT));
        await expect.poll(async () => (await terminalProbes(win)).map((p) => p.fontWeight), {
          message: 'every terminal reverts to the stored weight',
        }).toEqual([DEFAULT, DEFAULT]);
        expect(await storedWeight(win), 'the stored value is unchanged').toBeNull();
        expect(await invokeCalls(app, CHANNEL), 'exactly one save call').toHaveLength(1);
      } finally {
        await restoreHandler(app, CHANNEL);
      }

      // Positive control: with the real handler restored, the same action now succeeds.
      await weightSelect(win).selectOption(String(600));
      await expect.poll(() => storedWeight(win), { timeout: E2E_TIMEOUT }).toBe(600);
    } finally {
      await harness.close();
    }
  });
});
