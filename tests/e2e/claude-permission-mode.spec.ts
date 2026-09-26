/**
 * Claude permission-mode — first-run modal, blocking, launch-argv rewrite,
 * persistence, and the Settings control.
 *
 * Covers AC1, AC3, AC4, AC4a, AC16, AC17, AC18 (docs/specs/claude-permission-mode.md).
 * No permission-mode env override here — the whole point is to observe the
 * unchosen state on a fresh HOME (the other four specs pre-seed `bypass` to
 * skip this dialog; this spec is the one place it must appear).
 *
 * A real "claude" binary name is required for `withPermissionMode` to treat
 * the argv as rewritable Claude argv (AC11 excludes non-Claude names such as
 * running mock-claude.mjs directly via `node`). So this spec builds a tiny
 * shell shim literally named `claude` that execs the existing mock-claude.mjs,
 * and points the launch env at that shim.
 */

import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('Claude permission mode: first-run modal, blocking, argv rewrite, persistence, Settings control', async () => {
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  const isolatedHome = mkdtempSync(join(tmpdir(), 'metaide-permmode-home-'));
  const demoRoot = mkdtempSync(join(tmpdir(), 'metaide-permmode-root-'));
  const proj = join(demoRoot, 'permproj');
  mkdirSync(proj);
  mkdirSync(join(proj, '.git'));

  // ── Shim: a binary literally named `claude` that execs mock-claude.mjs ────
  const binDir = mkdtempSync(join(tmpdir(), 'metaide-permmode-bin-'));
  const shimPath = join(binDir, 'claude');
  writeFileSync(shimPath, `#!/bin/sh\nexec node ${mockClaude} "$@"\n`);
  chmodSync(shimPath, 0o755);

  const launchEnv = {
    ...process.env,
    HOME: isolatedHome,
    METAIDE_TEST_MODE: '1',
    METAIDE_DEFAULT_LAUNCH_FIRST: JSON.stringify({ argv: [shimPath], env: {} }),
    METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: [shimPath, '--continue'], env: {} }),
  };
  // No METAIDE_CLAUDE_PERMISSION_MODE override — mode starts unchosen (AC1).
  delete (launchEnv as Record<string, string | undefined>).METAIDE_CLAUDE_PERMISSION_MODE;

  // Own user-data dir: Electron's default userData path is not reliably
  // isolated by HOME alone (see root-removal.spec.ts), so persisted
  // renderer state and the single-instance lock can leak across launches
  // without this.
  const userDataArg = `--user-data-dir=${join(isolatedHome, 'userData')}`;
  let app = await electron.launch({ args: ['.', userDataArg], env: launchEnv });
  let win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  // ── AC1 / AC4a: dialog visible, Auto preselected + "Recommended", Bypass not ──
  // The test-id lands on the <input type="radio"> itself (PermissionModeDialog.tsx
  // ModeOption), not a wrapper — so the option is the radio, and its label text
  // ("Recommended" badge) lives in a sibling <span> under the enclosing <label>.
  const dialog = win.getByTestId('permission-mode-dialog');
  await expect(dialog).toBeVisible({ timeout: 10000 });
  const autoOption = dialog.getByTestId('permission-mode-option-auto');
  const bypassOption = dialog.getByTestId('permission-mode-option-bypass');
  const autoLabel = autoOption.locator('xpath=ancestor::label[1]');
  await expect(autoLabel).toContainText('Recommended');
  await expect(autoOption).toBeChecked();
  await expect(bypassOption).not.toBeChecked();

  // ── AC4: Escape does not dismiss ───────────────────────────────────────────
  await win.keyboard.press('Escape');
  await expect(dialog).toBeVisible();

  // ── AC4: backdrop click does not dismiss ───────────────────────────────────
  await win.mouse.click(2, 2);
  await expect(dialog).toBeVisible();

  // ── AC4: ⌘, does not open Settings while the dialog is up ──────────────────
  await win.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true, cancelable: true }));
  });
  await expect(win.getByTestId('settings-modal')).toHaveCount(0);
  await expect(dialog).toBeVisible();

  // ── AC4: ⌘K does not open the project switcher while the dialog is up ─────
  await win.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }));
  });
  await expect(win.getByPlaceholder('Switch to project…')).toHaveCount(0);
  await expect(dialog).toBeVisible();

  // ── Confirm with Auto (the preselected default) ────────────────────────────
  await dialog.getByTestId('permission-mode-confirm').click();
  await expect(dialog).toHaveCount(0);

  // Positive control: the locators above genuinely detect these overlays once
  // the app is unblocked — ⌘K now opens the switcher, and Escape now closes it.
  await win.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }));
  });
  const switcherInput = win.getByPlaceholder('Switch to project…');
  await expect(switcherInput).toBeVisible({ timeout: 3000 });
  await win.keyboard.press('Escape');
  await expect(switcherInput).toHaveCount(0);

  // ── AC16: first launch after choosing Auto carries --permission-mode auto ──
  // Add root via IPC directly. `dialogs:pick-directory` always resolves
  // `{ path: null }` under METAIDE_TEST_MODE=1 (register.ts), so clicking
  // "+ Root" is a no-op there; `roots:add` broadcasts `projects:changed`,
  // which useRoots listens for, so the sidebar picks it up without a reload.
  await win.evaluate(async (path: string) => {
    const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }).api;
    await api.invoke('roots:add', { path });
  }, demoRoot);
  const projButton = win.getByRole('button', { name: 'permproj', exact: true });
  await expect(projButton).toBeVisible({ timeout: 5000 });
  await projButton.click();
  await expect(win.locator('.xterm')).toBeVisible({ timeout: 10000 });

  const aliveShells = await win.evaluate(async () => {
    const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<{ shells: Array<{ launchArgv: string[] }> }> } }).api;
    return (await api.invoke('shells:alive-list', undefined)).shells;
  });
  expect(aliveShells.length).toBeGreaterThan(0);
  const firstShell = aliveShells[0];
  if (!firstShell) throw new Error('expected at least one alive shell');
  const firstArgv = firstShell.launchArgv;
  const flagIdx = firstArgv.indexOf('--permission-mode');
  expect(flagIdx, `launchArgv was ${JSON.stringify(firstArgv)}`).toBeGreaterThanOrEqual(0);
  expect(firstArgv[flagIdx + 1]).toBe('auto');

  await app.close();

  // ── AC3: relaunching with the same HOME does not show the dialog again ────
  app = await electron.launch({ args: ['.', userDataArg], env: launchEnv });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await expect(win.getByTestId('permission-mode-dialog')).toHaveCount(0);

  // ── AC17/AC18: Settings → Launch commands reflects the mode and updates live ──
  win.on('dialog', (d) => { void d.accept(); });
  await win.getByTestId('settings-open').click();
  const settingsModal = win.getByTestId('settings-modal');
  await expect(settingsModal).toBeVisible({ timeout: 5000 });
  await settingsModal.getByRole('button', { name: 'Launch commands' }).click();

  const settingsAuto = settingsModal.getByTestId('settings-permission-mode-auto');
  const settingsBypass = settingsModal.getByTestId('settings-permission-mode-bypass');
  await expect(settingsAuto).toHaveAttribute('aria-pressed', 'true');
  await expect(settingsBypass).toHaveAttribute('aria-pressed', 'false');

  // Test-id lands on the <input> itself (Settings.tsx LaunchEditor); the argv
  // is its `value`, not textContent, so assert with toHaveValue/inputValue
  // rather than toContainText.
  const firstEditor = settingsModal.getByTestId('launch-editor-first');
  const subsequentEditor = settingsModal.getByTestId('launch-editor-subsequent');
  // Positive control before switching: the Auto flag is present right now,
  // proving the toHaveValue check below can actually detect it.
  await expect(firstEditor).toHaveValue(/--permission-mode/);
  await expect(firstEditor).toHaveValue(/auto/);

  await settingsBypass.click();
  await expect(settingsBypass).toHaveAttribute('aria-pressed', 'true');
  await expect(settingsAuto).toHaveAttribute('aria-pressed', 'false');

  // Editors refresh in place without reopening Settings (AC18).
  await expect(firstEditor).toHaveValue(/--dangerously-skip-permissions/);
  await expect(firstEditor).not.toHaveValue(/--permission-mode/);
  await expect(subsequentEditor).toHaveValue(/--dangerously-skip-permissions/);
  await expect(subsequentEditor).toHaveValue(/--continue/);

  await win.getByTestId('settings-done').click();

  await app.close();
  rmSync(isolatedHome, { recursive: true, force: true });
  rmSync(demoRoot, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});
