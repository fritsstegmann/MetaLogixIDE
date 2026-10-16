import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PALETTE_TESTIDS } from '../../src/renderer/command-palette-contract';

/**
 * Modifier and arrow glyphs in keyboard hints keep the proportions macOS draws them at. The
 * status bar's `⌘K` hint is the reference `kbd`: each glyph is drawn at 100px in a probe, once in
 * the kbd's computed font stack and once in `system-ui`, and its ink height relative to `K` in the
 * kbd stack must reach MIN_SHARE of the same ratio in the native UI font. Menlo, which the
 * monospace stack resolves to, draws ⌘ at 74% of `K` where the native font draws it at 103%.
 */

const PROBE_PX = 100;
/** Share of the native glyph-to-`K` ratio a hint glyph must reach in the kbd stack. */
const MIN_SHARE = 0.9;
const GLYPHS = ['⌘', '⇧', '⌥', '↩', '↑', '↓'] as const;

let app: ElectronApplication;
let win: Page;
let home: string;

test.skip(process.platform !== 'darwin', 'modifier glyphs are mac-only labels');

test.beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'metaide-kbd-home-'));
  app = await electron.launch({
    args: ['.', `--user-data-dir=${join(home, 'userData')}`],
    env: { ...process.env, HOME: home, METAIDE_TEST_MODE: '1' },
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  rmSync(home, { recursive: true, force: true });
});

/** Renders `glyph` at PROBE_PX in `family`, or the status-bar kbd's stack, and returns its ink height in CSS px. */
async function inkHeight(glyph: string, family?: string): Promise<number> {
  const rect = await win.evaluate(async ({ glyph, family, px, testId }) => {
    const kbd = document.querySelector(`[data-testid="${testId}"] kbd`);
    if (!kbd) throw new Error('status-bar kbd not rendered');
    const probe = document.createElement('div');
    probe.id = 'kbd-glyph-probe';
    Object.assign(probe.style, {
      position: 'fixed', left: '0', top: '0', zIndex: '2147483647', width: `${px * 2}px`, height: `${px * 2}px`,
      background: '#fff', color: '#000', fontFamily: family ?? getComputedStyle(kbd).fontFamily,
      fontSize: `${px}px`, lineHeight: `${px * 2}px`, textAlign: 'center',
    });
    probe.textContent = glyph;
    document.getElementById('kbd-glyph-probe')?.remove();
    document.body.append(probe);
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { width: px * 2, height: px * 2 };
  }, { glyph, family, px: PROBE_PX, testId: PALETTE_TESTIDS.statusHint });

  return app.evaluate(async ({ BrowserWindow }, rect) => {
    const bw = BrowserWindow.getAllWindows()[0];
    const image = await bw.webContents.capturePage({ x: 0, y: 0, width: rect.width, height: rect.height });
    const { width, height } = image.getSize();
    const scale = width / rect.width;
    const bitmap = image.toBitmap();
    let top = Infinity;
    let bottom = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (bitmap[(y * width + x) * 4 + 1] < 128) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
      }
    }
    return bottom < 0 ? 0 : (bottom - top + 1) / scale;
  }, rect);
}

test('modifier and arrow glyphs in the kbd stack keep their native size relative to a capital letter', async () => {
  await expect(win.getByTestId(PALETTE_TESTIDS.statusHint).locator('kbd')).toBeVisible({ timeout: 10_000 });
  const kbdCapital = await inkHeight('K');
  const nativeCapital = await inkHeight('K', 'system-ui');
  expect(kbdCapital, 'positive control: K renders ink in the kbd stack').toBeGreaterThan(PROBE_PX * 0.5);
  expect(nativeCapital, 'positive control: K renders ink in system-ui').toBeGreaterThan(PROBE_PX * 0.5);
  const shares: Record<string, number> = {};
  for (const glyph of GLYPHS) {
    const kbdRatio = (await inkHeight(glyph)) / kbdCapital;
    const nativeRatio = (await inkHeight(glyph, 'system-ui')) / nativeCapital;
    shares[glyph] = Number((kbdRatio / nativeRatio).toFixed(2));
  }
  for (const glyph of GLYPHS) {
    expect(shares[glyph], `${glyph} kbd/native ratio share (${JSON.stringify(shares)})`).toBeGreaterThanOrEqual(MIN_SHARE);
  }
});
