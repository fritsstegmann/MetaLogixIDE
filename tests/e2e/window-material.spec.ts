/**
 * Window material: window opacity, backdrop blur and backdrop saturation.
 *
 * Covers AC4–AC12 of docs/specs/window-backdrop-blur-saturation.md (plan §9,
 * E4-0 .. E4-11). AC1–AC3 and AC13 are unit-tested; AC14 is the full suite.
 *
 * Every value is set through the Settings UI (never `settings:set`, which
 * rejects the material keys). CSS is read through `getComputedStyle` and
 * parsed into numbers: Chromium may serialise `saturate(180%)` as
 * `saturate(1.8)` and a relative colour as `rgba(…)` or `color(srgb …)`, so
 * nothing here string-matches a filter or a colour. Every negative assertion
 * ("no filter", "none") sits next to a positive control in the same render.
 *
 * Not covered here: the `chat-header` surface. ChatTab only renders it for a
 * user signed in to metaproject (ChatTab.tsx `if (!status.loggedIn)`), which
 * the isolated test HOME cannot be.
 */

import { test, expect, _electron as electron, type Page, type ElectronApplication, type Locator, type CDPSession } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_WINDOW_MATERIAL,
  MATERIAL_SURFACES,
  WINDOW_MATERIAL_SETTING_KEYS,
  type MaterialSurface,
  type WindowMaterial,
} from '../../src/shared/window-material';

/* ───────────────────────────── Parsers (E4-0) ───────────────────────────── */

interface ParsedFilter { none: boolean; blurPx: number; saturate: number }

/**
 * Parse a computed `backdrop-filter` into blur px and saturate as a ratio
 * (180% → 1.8, `saturate(1.8)` → 1.8). `none` parses as blur 0 / saturate 1
 * with `none: true`. Any other filter function fails loudly.
 */
function parseBackdropFilter(css: string): ParsedFilter {
  const text = css.trim();
  if (text === 'none' || text === '') return { none: true, blurPx: 0, saturate: 1 };
  const out: ParsedFilter = { none: false, blurPx: 0, saturate: 1 };
  const fn = /([a-z-]+)\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  let seen = 0;
  while ((m = fn.exec(text))) {
    seen++;
    const [, name, rawArg] = m;
    const arg = (rawArg ?? '').trim();
    if (name === 'blur') out.blurPx = arg === '' ? 0 : parseFloat(arg);
    else if (name === 'saturate') out.saturate = arg.endsWith('%') ? parseFloat(arg) / 100 : parseFloat(arg);
    else throw new Error(`unexpected filter function ${name} in "${css}"`);
  }
  if (seen === 0 || Number.isNaN(out.blurPx) || Number.isNaN(out.saturate)) throw new Error(`unparseable backdrop-filter "${css}"`);
  return out;
}

/** Alpha channel of a computed colour: rgb()/rgba() (comma or slash form), color(srgb … / a), or `transparent`. */
function parseAlpha(css: string): number {
  const text = css.trim();
  if (text === 'transparent') return 0;
  const inner = /^(?:rgba?|color|hsla?|oklch|oklab|lab|lch)\((.*)\)$/.exec(text)?.[1];
  if (inner === undefined) throw new Error(`unparseable colour "${css}"`);
  let alpha: string | undefined;
  if (inner.includes('/')) alpha = inner.split('/')[1];
  else if (inner.includes(',')) alpha = inner.split(',')[3];
  if (alpha === undefined) return 1;
  const a = alpha.trim();
  const n = a.endsWith('%') ? parseFloat(a) / 100 : parseFloat(a);
  if (Number.isNaN(n)) throw new Error(`unparseable alpha in "${css}"`);
  return n;
}

/* ───────────────────────────── Page probes ───────────────────────────── */

type Api = { invoke: (c: string, r: unknown) => Promise<unknown> };

/** Raw computed `backdrop-filter` of every mounted element of a surface. */
async function surfaceFilters(page: Page, surface: MaterialSurface): Promise<string[]> {
  return page.evaluate((s) => Array.from(document.querySelectorAll(`[data-material-surface="${s}"]`))
    .map((el) => getComputedStyle(el).backdropFilter), surface);
}

/** Waits until a surface is mounted and returns its computed filter in the same frame (for short-lived toasts). */
async function filterWhenMounted(page: Page, surface: MaterialSurface): Promise<string> {
  const handle = await page.waitForFunction((s) => {
    const el = document.querySelector(`[data-material-surface="${s}"]`);
    return el ? getComputedStyle(el).backdropFilter : null;
  }, surface, { timeout: 10000 });
  return (await handle.jsonValue()) as string;
}

/** Computed background-color alpha and text colour alpha of the first element matching `selector`. */
async function colours(page: Page, selector: string): Promise<{ bg: string; fg: string }> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`no element for ${sel}`);
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, fg: cs.color };
  }, selector);
}

/** Numeric value of an inline custom property on <html> (NaN if unset). */
async function rootVar(page: Page, name: string): Promise<number> {
  return page.evaluate((n) => parseFloat(document.documentElement.style.getPropertyValue(n)), name);
}

async function readStoredMaterial(page: Page): Promise<WindowMaterial> {
  return page.evaluate(async (keys) => {
    const api = (window as unknown as { api: Api }).api;
    const get = async (key: string) => ((await api.invoke('settings:get', { key })) as { value: number }).value;
    return { opacity: await get(keys.opacity), blur: await get(keys.blur), saturation: await get(keys.saturation) };
  }, WINDOW_MATERIAL_SETTING_KEYS);
}

/** Marks the page so a later check can prove it was not reloaded. */
async function markNoReload(page: Page): Promise<void> {
  await page.evaluate(() => { (window as unknown as { __wmMark: string }).__wmMark = 'kept'; });
}
async function stillNotReloaded(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __wmMark?: string }).__wmMark === 'kept');
}

/* ───────────────────────────── Harness ───────────────────────────── */

interface Ide { app: ElectronApplication; win: Page; home: string; root: string }

/**
 * Launches the built app on an isolated HOME and user-data dir (pattern from
 * claude-permission-mode.spec.ts). Pass an existing `home` to relaunch onto
 * the same persisted state.
 */
async function launch(existing?: { home: string; root: string }): Promise<Ide> {
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  const home = existing?.home ?? mkdtempSync(join(tmpdir(), 'metaide-material-home-'));
  const root = existing?.root ?? mkdtempSync(join(tmpdir(), 'metaide-material-root-'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(home, 'userData')}`],
    env: {
      ...process.env,
      HOME: home,
      METAIDE_TEST_MODE: '1',
      METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
      METAIDE_DEFAULT_LAUNCH_FIRST:      JSON.stringify({ argv: ['node', mockClaude],              env: {} }),
      METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: ['node', mockClaude, '--continue'], env: {} }),
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win, home, root };
}

async function teardown(ide: Ide): Promise<void> {
  await ide.app.close();
  rmSync(ide.home, { recursive: true, force: true });
  rmSync(ide.root, { recursive: true, force: true });
}

/** Creates git-looking project folders under the root and adds the root via IPC. */
async function addProjects(ide: Ide, names: string[]): Promise<void> {
  for (const name of names) {
    const dir = join(ide.root, name);
    mkdirSync(join(dir, '.git'), { recursive: true });
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'material-preview.md'), '# preview\n');
  }
  await ide.win.evaluate(async (path: string) => {
    await (window as unknown as { api: Api }).api.invoke('roots:add', { path });
  }, ide.root);
}

/** Selects a project and waits for its shell to render and mock-claude to print its banner. */
async function openProject(win: Page, name: string): Promise<void> {
  const row = win.locator('[data-testid="project-row"]', { hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 5000 });
  await row.click();
  await expect(win.locator('[data-testid="shell-tab"]')).toBeVisible({ timeout: 8000 });
  await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 8000 });
  await expect.poll(() => shellOutput(win, name), { timeout: 8000 }).toContain('mock-claude ready');
}

/** Reads the shell's terminal state via `shells:snapshot` (same helper as ui-polish.spec.ts). */
async function shellOutput(win: Page, projectName: string): Promise<string> {
  return win.evaluate(async (name: string) => {
    const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<never> } }).api;
    const { shells } = (await api.invoke('shells:alive-list', undefined)) as { shells: Array<{ projectId: number; projectName: string; shellIndex: number }> };
    const shell = shells.find((s) => s.projectName === name && s.shellIndex === 0);
    if (!shell) return '';
    const snap = (await api.invoke('shells:snapshot', { projectId: shell.projectId, shellIndex: shell.shellIndex })) as { output: string };
    return snap.output;
  }, projectName);
}

/** Pops the selected project's shell out (flow from ui-polish.spec.ts) and waits for its terminal. */
async function popOut(ide: Ide): Promise<Page> {
  const [popout] = await Promise.all([
    ide.app.waitForEvent('window'),
    ide.win.getByTestId('popout-shell').click(),
  ]);
  await popout.waitForLoadState('domcontentloaded');
  return popout;
}

async function waitForPopoutShell(popout: Page): Promise<void> {
  await expect(popout.locator('[data-testid="shell-tab"]')).toBeVisible({ timeout: 8000 });
  await expect(popout.locator('.xterm').first()).toBeVisible({ timeout: 8000 });
}

/* ───────────────────────────── Settings UI ───────────────────────────── */

const SLIDER = {
  opacity:    'window-opacity-slider',
  blur:       'window-blur-slider',
  saturation: 'window-saturation-slider',
} as const satisfies Record<keyof WindowMaterial, string>;

const UNIT: Record<keyof WindowMaterial, string> = { opacity: '%', blur: 'px', saturation: '%' };

async function openSettings(win: Page): Promise<void> {
  await win.getByTestId('ab-settings').click();
  await expect(win.getByTestId('settings-modal')).toBeVisible();
  // Values load asynchronously; the sliders are disabled until they have.
  await expect(win.getByTestId(SLIDER.opacity)).toBeEnabled();
}

async function closeSettings(win: Page): Promise<void> {
  await win.getByTestId('settings-done').click();
  await expect(win.getByTestId('settings-modal')).toHaveCount(0);
}

/** The monospace value readout next to a slider (WindowMaterialFields `MaterialSlider`). */
function readout(win: Page, field: keyof WindowMaterial): Locator {
  return win.getByTestId(SLIDER[field]).locator('xpath=following-sibling::span[1]');
}

/**
 * Drags the given sliders to their values through the open Settings modal,
 * then waits until main has stored exactly those values.
 */
async function setViaSliders(win: Page, patch: Partial<WindowMaterial>): Promise<void> {
  for (const [field, value] of Object.entries(patch) as Array<[keyof WindowMaterial, number]>) {
    await win.getByTestId(SLIDER[field]).fill(String(value));
    await expect(readout(win, field)).toHaveText(`${value}${UNIT[field]}`);
  }
  await expect.poll(async () => {
    const stored = await readStoredMaterial(win);
    return Object.entries(patch).every(([k, v]) => stored[k as keyof WindowMaterial] === v);
  }, { timeout: 5000 }).toBe(true);
}

/** Opens Settings, sets the values, closes Settings. */
async function setMaterial(win: Page, patch: Partial<WindowMaterial>): Promise<void> {
  await openSettings(win);
  await setViaSliders(win, patch);
  await closeSettings(win);
}

/** Polls until the window's titlebar-class surface filter parses to the expected blur / saturation. */
async function expectSurfaceFilter(page: Page, surface: MaterialSurface, blurPx: number, saturatePct: number): Promise<void> {
  await expect.poll(async () => {
    const all = await surfaceFilters(page, surface);
    return all.map((f) => { const p = parseBackdropFilter(f); return [p.blurPx, Math.round(p.saturate * 100)]; });
  }, { timeout: 5000, message: `${surface} backdrop-filter` }).toEqual(
    expect.arrayContaining([[blurPx, saturatePct]]),
  );
  // Every mounted instance, not just one, carries the value.
  const all = (await surfaceFilters(page, surface)).map(parseBackdropFilter);
  expect(all.length, `${surface} mounted`).toBeGreaterThan(0);
  for (const p of all) {
    expect(p.blurPx).toBeCloseTo(blurPx, 3);
    expect(p.saturate).toBeCloseTo(saturatePct / 100, 3);
  }
}

/* ───────────────────────── Transient surfaces ───────────────────────── */

/** Right-clicks a project row: mounts the context menu. */
async function openContextMenu(win: Page, projectName: string): Promise<void> {
  await win.locator('[data-testid="project-row"]', { hasText: projectName }).first().click({ button: 'right' });
  await expect(win.getByTestId('context-menu')).toBeVisible();
}

/** Picks "Copy full path" from the open context menu: raises a toast (success or, without clipboard access, error). */
async function raiseToastFromMenu(win: Page): Promise<void> {
  await win.getByTestId('context-menu').getByRole('menuitem', { name: 'Copy full path' }).click();
}

const HOVER_PATH = 'docs/material-preview.md';

/**
 * Prints a project-relative path into the terminal (mock-claude echoes it)
 * and sweeps the mouse over the terminal until xterm's path link provider
 * mounts the hover preview. xterm draws with WebGL, so there is no DOM text
 * to aim at; the sweep covers the columns the path occupies.
 */
async function openHoverPreview(page: Page, projectName: string, shellOwner: Page): Promise<void> {
  const term = page.locator('.xterm').first();
  await term.click();
  await page.keyboard.type(HOVER_PATH);
  await page.keyboard.press('Enter');
  await expect.poll(() => shellOutput(shellOwner, projectName), { timeout: 8000 }).toContain(`echo: ${HOVER_PATH}`);

  const box = await page.locator('.xterm-screen').first().boundingBox();
  if (!box) throw new Error('xterm screen has no box');
  const preview = page.getByTestId('hover-preview');
  // Path starts at column 3 ("> " echo) or 7 ("echo: "); ~8.4 px per 14 px SF Mono cell.
  const xs = [10, 16, 22].map((col) => box.x + col * 8.4).filter((x) => x < box.x + box.width);
  const tryAt = async (x: number, y: number, waitMs: number): Promise<boolean> => {
    await page.mouse.move(x, y);
    try {
      await preview.waitFor({ state: 'attached', timeout: waitMs });
      return true;
    } catch { return false; /* not over the link yet */ }
  };
  await page.mouse.move(box.x + box.width - 2, box.y + box.height - 2);

  // xterm parks its helper textarea on the cursor cell: after Enter the
  // cursor sits on the "> " prompt, just below the two lines holding the path.
  const cursor = await page.locator('.xterm-helper-textarea').first().boundingBox();
  if (cursor && cursor.height > 0) {
    for (const rowsUp of [1, 2, 3]) {
      const y = cursor.y - cursor.height * (rowsUp - 0.5);
      for (const x of xs) if (await tryAt(x, y, 250)) return;
    }
  }
  // Fallback: sweep the whole screen.
  for (let y = box.y + 4; y < box.y + box.height; y += 6) {
    for (const x of xs) if (await tryAt(x, y, 40)) return;
  }
  throw new Error('hover preview never mounted while sweeping the terminal');
}

/* ───────────────────────── Reduced transparency (CDP) ───────────────────────── */

/**
 * Emulates `prefers-reduced-transparency` over CDP. Returns whether the page
 * actually matches the requested state afterwards (Playwright has no
 * `reducedTransparency` option; Electron may or may not honour the feature).
 */
const cdpSessions = new WeakMap<Page, CDPSession>();

async function emulateReducedTransparency(page: Page, reduce: boolean): Promise<boolean> {
  // Emulation overrides belong to the CDP session that set them, so clearing
  // must go through the same session.
  let cdp = cdpSessions.get(page);
  if (!cdp) {
    cdp = await page.context().newCDPSession(page);
    cdpSessions.set(page, cdp);
  }
  try {
    await cdp.send('Emulation.setEmulatedMedia', {
      features: reduce ? [{ name: 'prefers-reduced-transparency', value: 'reduce' }] : [],
    });
  } catch {
    return false;
  }
  return page.evaluate((r) => matchMedia('(prefers-reduced-transparency: reduce)').matches === r, reduce);
}

/**
 * Fallback proof for AC11 when emulation is unavailable: the shipped
 * stylesheet has a `prefers-reduced-transparency: reduce` block that forces
 * `backdrop-filter: none` and alpha-1 surface colours. Reads cssRules, or the
 * stylesheet text if the file:// sheet is not script-readable.
 */
async function reducedTransparencyRuleText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const out: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (rule instanceof CSSMediaRule && rule.conditionText.includes('prefers-reduced-transparency')) out.push(rule.cssText);
        }
      } catch {
        if (sheet.href) {
          const text = await (await fetch(sheet.href)).text();
          const i = text.indexOf('prefers-reduced-transparency');
          if (i >= 0) out.push(text.slice(i, i + 2000));
        }
      }
    }
    return out.join('\n');
  });
}

/* ═══════════════════════════════ Tests ═══════════════════════════════ */

test.describe('window material', () => {
  test.skip(process.platform !== 'darwin', 'E2E host is macOS; non-macOS opacity (AC13) is unit-tested');

  // E4-0: record the real serialisations and CDP support, and prove the
  // parsers read them. Everything below relies on these parsers.
  test('E4-0 probe: computed serialisations parse, CDP reduced-transparency support recorded', async () => {
    const ide = await launch();
    try {
      const titlebar = await filterWhenMounted(ide.win, 'titlebar');
      const sidebar = await colours(ide.win, '[data-material-surface="sidebar"]');
      const cdpWorks = await emulateReducedTransparency(ide.win, true);
      if (cdpWorks) await emulateReducedTransparency(ide.win, false);
      test.info().annotations.push(
        { type: 'backdrop-filter serialisation', description: titlebar },
        { type: 'relative-colour serialisation', description: sidebar.bg },
        { type: 'CDP prefers-reduced-transparency emulation', description: cdpWorks ? 'supported' : 'unsupported: AC11 falls back to stylesheet check' },
      );

      // Parser self-checks on both serialisations Chromium may emit.
      expect(parseBackdropFilter('blur(20px) saturate(180%)')).toEqual({ none: false, blurPx: 20, saturate: 1.8 });
      expect(parseBackdropFilter('blur(20px) saturate(1.8)')).toEqual({ none: false, blurPx: 20, saturate: 1.8 });
      expect(parseBackdropFilter('none')).toEqual({ none: true, blurPx: 0, saturate: 1 });
      expect(parseAlpha('rgba(28, 32, 40, 0.574)')).toBeCloseTo(0.574, 6);
      expect(parseAlpha('color(srgb 0.1 0.2 0.3 / 0.574)')).toBeCloseTo(0.574, 6);
      expect(parseAlpha('rgb(28, 32, 40)')).toBe(1);

      // And on what this Chromium actually produced, at defaults (AC9 anchor).
      const parsed = parseBackdropFilter(titlebar);
      expect(parsed.none).toBe(false);
      expect(parsed.blurPx).toBe(DEFAULT_WINDOW_MATERIAL.blur);
      expect(parsed.saturate).toBeCloseTo(DEFAULT_WINDOW_MATERIAL.saturation / 100, 3);
      expect(parseAlpha(sidebar.bg)).toBeGreaterThan(0);
    } finally {
      await teardown(ide);
    }
  });

  // E4-4 + E4-5: AC5 (sliders, readouts, keyboard) and AC6 (reset persists).
  test('AC5/AC6: blur and saturation sliders sit under opacity, step by keyboard, and reset restores defaults', async () => {
    const ide = await launch();
    const { win } = ide;
    try {
      await openSettings(win);
      const opacity = win.getByTestId(SLIDER.opacity);
      const blur = win.getByTestId(SLIDER.blur);
      const saturation = win.getByTestId(SLIDER.saturation);

      // AC5: defaults and readout format.
      await expect(readout(win, 'opacity')).toHaveText('100%');
      await expect(readout(win, 'blur')).toHaveText('20px');
      await expect(readout(win, 'saturation')).toHaveText('180%');
      await expect(blur).toHaveAttribute('min', '0');
      await expect(blur).toHaveAttribute('max', '40');
      await expect(blur).toHaveAttribute('step', '1');
      await expect(saturation).toHaveAttribute('min', '100');
      await expect(saturation).toHaveAttribute('max', '200');
      await expect(saturation).toHaveAttribute('step', '5');

      // AC5: directly under "Window opacity": opacity, then blur, then saturation.
      const [yo, yb, ys] = await Promise.all([opacity, blur, saturation].map(async (l) => (await l.boundingBox())?.y ?? NaN));
      expect(yo).toBeLessThan(yb ?? NaN);
      expect(yb).toBeLessThan(ys ?? NaN);

      // AC5: keyboard operable, one step per arrow press, and the change persists.
      await blur.focus();
      await win.keyboard.press('ArrowRight');
      await expect(readout(win, 'blur')).toHaveText('21px');
      await saturation.focus();
      await win.keyboard.press('ArrowRight');
      await expect(readout(win, 'saturation')).toHaveText('185%');
      await expect.poll(() => readStoredMaterial(win)).toEqual({ opacity: 100, blur: 21, saturation: 185 });

      // AC6: change all three, then reset.
      await setViaSliders(win, { opacity: 55, blur: 8, saturation: 120 });
      await win.getByTestId('window-material-reset').click();
      await expect(readout(win, 'opacity')).toHaveText('100%');
      await expect(readout(win, 'blur')).toHaveText('20px');
      await expect(readout(win, 'saturation')).toHaveText('180%');
      await expect.poll(() => readStoredMaterial(win)).toEqual(DEFAULT_WINDOW_MATERIAL);
      // The reset reached the rendered material too, not just storage.
      await expect.poll(() => rootVar(win, '--material-blur')).toBe(20);
      await expect.poll(() => rootVar(win, '--material-saturate')).toBe(180);

      // AC6: reopening Settings shows the reset values.
      await closeSettings(win);
      await openSettings(win);
      await expect(readout(win, 'opacity')).toHaveText('100%');
      await expect(readout(win, 'blur')).toHaveText('20px');
      await expect(readout(win, 'saturation')).toHaveText('180%');
    } finally {
      await teardown(ide);
    }
  });

  // E4-3: AC4 (persist across restart, applied before first render).
  test('AC4: values survive a restart and are on <html> at domcontentloaded, before any interaction', async () => {
    let ide = await launch();
    const persisted = { opacity: 70, blur: 30, saturation: 150 };
    try {
      // Positive control: a fresh launch starts on the defaults.
      expect(await readStoredMaterial(ide.win)).toEqual(DEFAULT_WINDOW_MATERIAL);
      await setMaterial(ide.win, persisted);
      await ide.app.close();

      ide = await launch({ home: ide.home, root: ide.root });
      // `launch` returns at domcontentloaded; read before anything else runs.
      const early = await ide.win.evaluate(() => {
        const s = document.documentElement.style;
        return {
          alpha: parseFloat(s.getPropertyValue('--material-alpha')),
          blur: parseFloat(s.getPropertyValue('--material-blur')),
          saturate: parseFloat(s.getPropertyValue('--material-saturate')),
        };
      });
      expect(early.alpha).toBeCloseTo(persisted.opacity / 100, 6);
      expect(early.blur).toBe(persisted.blur);
      expect(early.saturate).toBe(persisted.saturation);

      expect(await readStoredMaterial(ide.win)).toEqual(persisted);
      await openSettings(ide.win);
      await expect(readout(ide.win, 'opacity')).toHaveText('70%');
      await expect(readout(ide.win, 'blur')).toHaveText('30px');
      await expect(readout(ide.win, 'saturation')).toHaveText('150%');
      await expect(ide.win.getByTestId(SLIDER.opacity)).toHaveValue('70');
      await expect(ide.win.getByTestId(SLIDER.blur)).toHaveValue('30');
      await expect(ide.win.getByTestId(SLIDER.saturation)).toHaveValue('150');
    } finally {
      await teardown(ide);
    }
  });

  // E4-6: AC7 (live in every window; a popout opened later starts current).
  test('AC7: slider changes reach an open popout live, and a later popout starts on the current values', async () => {
    const ide = await launch();
    const { win } = ide;
    try {
      await addProjects(ide, ['alpha', 'beta']);
      await openProject(win, 'alpha');
      const first = await popOut(ide);
      await waitForPopoutShell(first);
      await expectSurfaceFilter(first, 'popout-titlebar', 20, 180);
      await markNoReload(first);
      await markNoReload(win);

      // Blur moves live in both windows, no reload.
      await openSettings(win);
      await setViaSliders(win, { blur: 33 });
      await expectSurfaceFilter(first, 'popout-titlebar', 33, 180);
      await expectSurfaceFilter(win, 'titlebar', 33, 180);

      // Then saturation.
      await setViaSliders(win, { saturation: 125 });
      await expectSurfaceFilter(first, 'popout-titlebar', 33, 125);
      await expectSurfaceFilter(win, 'titlebar', 33, 125);
      expect(await stillNotReloaded(first)).toBe(true);
      expect(await stillNotReloaded(win)).toBe(true);
      await closeSettings(win);

      // A popout opened after the change starts on the current values.
      await openProject(win, 'beta');
      const second = await popOut(ide);
      const early = await second.evaluate(() => ({
        blur: parseFloat(document.documentElement.style.getPropertyValue('--material-blur')),
        saturate: parseFloat(document.documentElement.style.getPropertyValue('--material-saturate')),
      }));
      expect(early).toEqual({ blur: 33, saturate: 125 });
      await waitForPopoutShell(second);
      await expectSurfaceFilter(second, 'popout-titlebar', 33, 125);
    } finally {
      await teardown(ide);
    }
  });

  // E4-7: AC8 (macOS: native opacity stays 1, surface alpha scales, text never fades).
  test('AC8: at 70% every window keeps getOpacity() 1 and only surface alpha scales', async () => {
    const ide = await launch();
    const { win } = ide;
    try {
      await addProjects(ide, ['alpha']);
      await openProject(win, 'alpha');
      const popout = await popOut(ide);
      await waitForPopoutShell(popout);

      const sidebar = '[data-material-surface="sidebar"]';
      const base = parseAlpha(await win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--panel-base')));
      expect(base, 'dark --panel base alpha (spec AC8 example)').toBeCloseTo(0.82, 3);

      // At 100: the theme alpha exactly.
      await expect(win.locator('html')).toHaveAttribute('data-theme', 'dark');
      expect(parseAlpha((await colours(win, sidebar)).bg)).toBeCloseTo(base, 3);

      await setMaterial(win, { opacity: 70 });
      const opacities = await ide.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getOpacity()));
      expect(opacities.length, 'main + popout').toBeGreaterThanOrEqual(2);
      for (const o of opacities) expect(o).toBe(1);

      await expect.poll(async () => parseAlpha((await colours(win, sidebar)).bg), { timeout: 5000 })
        .toBeCloseTo(base * 0.7, 2);
      const scaled = parseAlpha((await colours(win, sidebar)).bg);
      expect(Math.abs(scaled - base * 0.7)).toBeLessThanOrEqual(0.005);
      // Text is never scaled.
      expect(parseAlpha((await colours(win, sidebar)).fg)).toBe(1);
      // The popout's surfaces scale too (its <html> carries the same alpha).
      await expect.poll(() => rootVar(popout, '--material-alpha')).toBeCloseTo(0.7, 6);

      // Back to 100: exact theme alpha again.
      await setMaterial(win, { opacity: 100 });
      await expect.poll(async () => parseAlpha((await colours(win, sidebar)).bg)).toBeCloseTo(base, 3);
    } finally {
      await teardown(ide);
    }
  });

  // E4-8: AC9 (every material surface carries the set blur / saturation; scrims keep 4px).
  test('AC9: every material surface resolves to the set blur and saturation, at defaults and after a change', async () => {
    const ide = await launch();
    const { win } = ide;
    const seen = new Set<MaterialSurface>();
    const check = async (page: Page, surface: MaterialSurface, blurPx: number, satPct: number) => {
      await expectSurfaceFilter(page, surface, blurPx, satPct);
      seen.add(surface);
    };
    try {
      await addProjects(ide, ['alpha']);
      await openProject(win, 'alpha');
      await win.getByTestId('ab-git').click();
      await expect(win.locator('[data-material-surface="section-panel"]')).toBeVisible();

      // ── Defaults 20 / 180 ──
      for (const s of ['titlebar', 'statusbar', 'activitybar', 'sidebar', 'section-panel'] as const) await check(win, s, 20, 180);
      await openContextMenu(win, 'alpha');
      await check(win, 'context-menu', 20, 180);
      await win.keyboard.press('Escape');
      await expect(win.getByTestId('context-menu')).toHaveCount(0);
      await openHoverPreview(win, 'alpha', win);
      await check(win, 'hover-preview', 20, 180);
      // Popping out raises a toast in main and gives the popout title bar.
      const popout = await popOut(ide);
      const toastDefault = parseBackdropFilter(await filterWhenMounted(win, 'toast'));
      expect([toastDefault.blurPx, Math.round(toastDefault.saturate * 100)]).toEqual([20, 180]);
      seen.add('toast');
      await waitForPopoutShell(popout);
      await check(popout, 'popout-titlebar', 20, 180);

      // ── After 30 / 150 ──
      await openSettings(win);
      await setViaSliders(win, { blur: 30, saturation: 150 });
      // Scrims keep their own 4px blur and no saturation (positive: the scrim is mounted).
      const scrim = parseBackdropFilter(await win.getByTestId('settings-modal').evaluate((el) => getComputedStyle(el).backdropFilter));
      expect(scrim).toEqual({ none: false, blurPx: 4, saturate: 1 });
      await closeSettings(win);

      for (const s of ['titlebar', 'statusbar', 'activitybar', 'sidebar', 'section-panel'] as const) await check(win, s, 30, 150);
      await check(popout, 'popout-titlebar', 30, 150);
      await openContextMenu(win, 'alpha');
      await check(win, 'context-menu', 30, 150);
      await raiseToastFromMenu(win);
      const toastChanged = parseBackdropFilter(await filterWhenMounted(win, 'toast'));
      expect([toastChanged.blurPx, Math.round(toastChanged.saturate * 100)]).toEqual([30, 150]);
      // The shell now lives in the popout, so the hover preview is raised there.
      await openHoverPreview(popout, 'alpha', win);
      await check(popout, 'hover-preview', 30, 150);

      // Every surface in the contract was exercised, except chat-header (see file header).
      expect([...seen].sort()).toEqual(MATERIAL_SURFACES.filter((s) => s !== 'chat-header').sort());
    } finally {
      await teardown(ide);
    }
  });

  // E4-9: AC10 (no filter on any xterm ancestor, main and popout, any setting).
  test('AC10: no ancestor of any .xterm has a filter or backdrop-filter, at defaults and at 40/200', async () => {
    const ide = await launch();
    const { win } = ide;
    type Offender = { tag: string; cls: string; filter: string; backdrop: string };
    const offenders = (page: Page) => page.evaluate(() => {
      const bad: Offender[] = [];
      const terms = Array.from(document.querySelectorAll('.xterm'));
      for (const t of terms) {
        for (let el: Element | null = t; el; el = el.parentElement) {
          const cs = getComputedStyle(el);
          if (cs.filter !== 'none' || cs.backdropFilter !== 'none') {
            bad.push({ tag: el.tagName, cls: String(el.className), filter: cs.filter, backdrop: cs.backdropFilter });
          }
        }
      }
      return { terms: terms.length, bad };
    });
    const assertClean = async (page: Page, surface: MaterialSurface, blurPx: number, satPct: number) => {
      const r = await offenders(page);
      expect(r.terms, 'an .xterm is mounted').toBeGreaterThan(0);
      expect(r.bad).toEqual([]);
      // Positive control, same render: the material filter is live elsewhere.
      await expectSurfaceFilter(page, surface, blurPx, satPct);
    };
    try {
      await addProjects(ide, ['alpha']);
      await openProject(win, 'alpha');
      await assertClean(win, 'titlebar', 20, 180);

      await setMaterial(win, { blur: 40, saturation: 200 });
      await assertClean(win, 'titlebar', 40, 200);

      const popout = await popOut(ide);
      await waitForPopoutShell(popout);
      await assertClean(popout, 'popout-titlebar', 40, 200);

      await setMaterial(win, { blur: 20, saturation: 180 });
      await assertClean(popout, 'popout-titlebar', 20, 180);
    } finally {
      await teardown(ide);
    }
  });

  // E4-10: AC11 (reduce transparency: no backdrop filters, opaque surfaces, live both ways).
  test('AC11: prefers-reduced-transparency removes every backdrop filter and opacity, and clearing it restores the stored values live', async () => {
    const ide = await launch();
    const { win } = ide;
    try {
      await addProjects(ide, ['alpha']);
      await openProject(win, 'alpha');
      await win.getByTestId('ab-git').click();
      await setMaterial(win, { opacity: 60, blur: 30, saturation: 150 });
      // Positive control before emulation: filters and scaled alpha are live.
      await expectSurfaceFilter(win, 'sidebar', 30, 150);
      const sidebar = '[data-material-surface="sidebar"]';
      const base = parseAlpha(await win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--panel-base')));
      await expect.poll(async () => parseAlpha((await colours(win, sidebar)).bg)).toBeCloseTo(base * 0.6, 2);
      await markNoReload(win);

      const emulated = await emulateReducedTransparency(win, true);
      if (!emulated) {
        test.info().annotations.push({ type: 'gap', description: 'CDP cannot emulate prefers-reduced-transparency on this Electron; AC11 checked via stylesheet only' });
        const rules = await reducedTransparencyRuleText(win);
        expect(rules).toContain('prefers-reduced-transparency');
        expect(rules).toMatch(/backdrop-filter:\s*none\s*!important/);
        for (const v of ['--bg', '--panel', '--panel-strong', '--chat-surface']) expect(rules).toContain(`${v}:`);
        return;
      }

      await openContextMenu(win, 'alpha');
      const surfaces = await win.evaluate(() => Array.from(document.querySelectorAll('[data-material-surface]')).map((el) => {
        const cs = getComputedStyle(el);
        return { surface: el.getAttribute('data-material-surface'), backdrop: cs.backdropFilter, bg: cs.backgroundColor };
      }));
      const mounted = new Set(surfaces.map((s) => s.surface));
      for (const s of ['titlebar', 'statusbar', 'activitybar', 'sidebar', 'section-panel', 'context-menu']) expect(mounted.has(s), `${s} mounted`).toBe(true);
      for (const s of surfaces) {
        expect(parseBackdropFilter(s.backdrop).none, `${s.surface} backdrop-filter`).toBe(true);
        // Surfaces with a tint of their own are fully opaque. Title/status/activity
        // bars have none of their own (spec assumption: dead `bg-[--panel]/NN`).
        const a = parseAlpha(s.bg);
        if (a > 0) expect(a, `${s.surface} background alpha`).toBe(1);
      }
      expect(parseAlpha((await colours(win, sidebar)).bg), 'sidebar has a tint and it is opaque').toBe(1);
      expect(parseAlpha((await colours(win, 'html')).bg), '--bg on <html>').toBe(1);
      await win.keyboard.press('Escape');

      // Scrim: backdrop-filter none, tint unchanged (bg-black/50).
      await openSettings(win);
      const scrim = await colours(win, '[data-testid="settings-modal"]');
      expect(parseBackdropFilter(await win.getByTestId('settings-modal').evaluate((el) => getComputedStyle(el).backdropFilter)).none).toBe(true);
      expect(parseAlpha(scrim.bg)).toBeCloseTo(0.5, 3);
      await closeSettings(win);

      // Clearing the OS setting restores the stored values without a reload.
      expect(await emulateReducedTransparency(win, false)).toBe(true);
      await expectSurfaceFilter(win, 'sidebar', 30, 150);
      await expect.poll(async () => parseAlpha((await colours(win, sidebar)).bg)).toBeCloseTo(base * 0.6, 2);
      expect(await stillNotReloaded(win)).toBe(true);
    } finally {
      await teardown(ide);
    }
  });

  // E4-11: AC12 (blur 0 / saturation 100: plain translucency, no errors).
  test('AC12: blur 0 and saturation 100 give no blur and no colour change, with no errors', async () => {
    const ide = await launch();
    const { win } = ide;
    const errors: string[] = [];
    win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    win.on('pageerror', (e) => errors.push(e.message));
    try {
      // Positive control: the collector sees a real console error.
      await win.evaluate(() => console.error('window-material-probe'));
      await expect.poll(() => errors.includes('window-material-probe')).toBe(true);
      errors.length = 0;

      await expectSurfaceFilter(win, 'titlebar', 20, 180);
      await setMaterial(win, { blur: 0, saturation: 100 });
      await expect.poll(async () => {
        const p = parseBackdropFilter((await surfaceFilters(win, 'titlebar'))[0] ?? '');
        return [p.blurPx, p.saturate];
      }).toEqual([0, 1]);
      for (const s of ['statusbar', 'activitybar', 'sidebar'] as const) {
        for (const f of await surfaceFilters(win, s)) {
          const p = parseBackdropFilter(f);
          expect(p.blurPx).toBe(0);
          expect(p.saturate).toBe(1);
        }
      }
      expect(errors).toEqual([]);
    } finally {
      await teardown(ide);
    }
  });
});
