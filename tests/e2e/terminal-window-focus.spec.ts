/**
 * Focus the terminal when the window gains OS focus.
 *
 * Spec: docs/specs/focus-terminal-on-window-focus.md
 * Plan: docs/plan/focus-terminal-on-window-focus.md (Agent 2 checklist, §7-8)
 *
 * This file owns no source under src/ — it drives only the DOM and the
 * main-process surface: [data-testid="shell-tab"], .split-left /
 * [data-testid="split-right"], .xterm-helper-textarea, the Shell/Files tab
 * buttons, popout-shell, the `shell:focus-request` IPC channel, and
 * BrowserWindow blur()/focus().
 *
 * Refocus mechanism used: `refocus()` dispatches a synthetic `focus` Event
 * directly on `window` (`win.evaluate(() => window.dispatchEvent(new
 * Event('focus')))`) — the plan's documented fallback. Real OS-level
 * refocus via `app.browserWindow(win).evaluate((w) => { w.blur(); w.focus(); })`
 * was tried first and proved unreliable under this runner: run back to
 * back with no other change, `BrowserWindow.isFocused()` toggled false
 * then true as expected, but the corresponding DOM `window` `focus` event
 * did not consistently follow, so tests gated on it flaked pass/fail on
 * identical code. Dispatching the event directly drives the exact
 * listener `useWindowTerminalFocus` installs, deterministically. AC10's
 * notification-path helper still uses the real main-process
 * `BrowserWindow.blur()`/`show()`/`focus()` before `webContents.send(...)`,
 * since that path does not depend on the `window` `focus` DOM event at all
 * (`shell:focus-request` calls `terminalFocus.requestFocus` directly).
 *
 * AC12 approximation limit: Playwright cannot reproduce the real OS
 * ordering of an activating click (window activation arrives before the
 * click's own element-focus in Chromium/Electron). The AC12 test below
 * approximates it with real `BrowserWindow.blur()` → click → `focus()`,
 * which exercises the same code path (the coordinator's focus call is
 * synchronous inside the `window` `focus` handler) but does not prove the
 * literal event order. Its assertion (the clicked text-entry keeps focus)
 * holds whether or not the DOM `focus` event actually follows the real
 * BrowserWindow focus() call, so it is not sensitive to the flakiness
 * above. The real guarantee is structural (Agent 1's synchronous handler),
 * not something this suite can observe end-to-end.
 *
 * Selector/contract assumption flagged to the orchestrator: AC3 and AC10's
 * D5 negative case name "the ChatTab composer" as a text-entry target.
 * ChatTab shows a metaproject login card (`mp-login-username` etc.) until
 * `metaproject:status` reports `loggedIn`, and there is no test-mode stub
 * for that login in this codebase (no METAIDE_TEST_MODE handling in
 * ChatTab or main). So the composer textarea is never reachable under
 * `METAIDE_TEST_MODE=1`. This suite substitutes the `mp-login-username`
 * input as the ChatTab-panel text-entry target: it is a genuine <input>,
 * classifies identically under `classifyActiveElement` (text-entry), and
 * exercises the same rule. If a chat-login test stub is added later, this
 * can be swapped for the real composer.
 */

import { test, expect, _electron as electron, type Page, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Api = { invoke: (c: string, r: unknown) => Promise<never> };

interface Launched {
  app: ElectronApplication;
  win: Page;
  demoRoot: string;
  cleanup: () => void;
}

/** Launches the app with an isolated profile and one project dir per name (each with a `.git`). */
async function launch(projectNames: string[] = ['alpha']): Promise<Launched> {
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  const isolatedHome = mkdtempSync(join(tmpdir(), 'metaide-focus-home-'));
  const demoRoot = mkdtempSync(join(tmpdir(), 'metaide-focus-root-'));
  for (const name of projectNames) {
    const proj = join(demoRoot, name);
    mkdirSync(proj);
    mkdirSync(join(proj, '.git'));
    writeFileSync(join(proj, 'notes.txt'), 'hello from notes\n');
  }
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
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1400, 900); });
  await win.evaluate(async (path: string) => {
    await (window as unknown as { api: Api }).api.invoke('roots:add', { path });
  }, demoRoot);
  return {
    app, win, demoRoot,
    cleanup: () => {
      rmSync(isolatedHome, { recursive: true, force: true });
      rmSync(demoRoot, { recursive: true, force: true });
    },
  };
}

/** Selects a project by exact sidebar row name and waits for its terminal to render. */
async function openProject(win: Page, name: string): Promise<void> {
  const row = win.locator('[data-testid="project-row"]', { hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 5000 });
  await row.click();
  await expect(win.locator('[data-testid="shell-tab"] .xterm-screen')).toBeVisible({ timeout: 10000 });
}

/**
 * Fires the renderer's `window` `focus` event, the trigger `useWindowTerminalFocus`
 * listens for. See the file header: real `BrowserWindow.blur()`/`focus()` proved
 * flaky under this runner (confirmed by running the same code back to back —
 * `isFocused()` toggled correctly but the DOM event did not reliably follow), so
 * this uses the plan's documented fallback — dispatching a `focus` event directly
 * on `window` — which drives the same listener deterministically.
 */
async function refocus(win: Page): Promise<void> {
  await win.evaluate(() => window.dispatchEvent(new Event('focus')));
}

/**
 * Real OS-level blur/focus of the actual BrowserWindow — used only by the
 * probe test below, to check the documentation-grounding assumption itself
 * (real activeElement persistence across a genuine OS blur/focus). Not used
 * as the suite's trigger mechanism; see `refocus()` and the file header.
 */
async function realBlurFocus(app: ElectronApplication, win: Page): Promise<void> {
  const handle = await app.browserWindow(win);
  await handle.evaluate((w) => w.blur());
  await handle.evaluate((w) => w.focus());
}

/** Forces `document.activeElement` to `<body>`, as if nothing had been clicked. */
async function blurToBody(win: Page): Promise<void> {
  await win.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
}

/** True iff the active element is an xterm helper textarea inside the given container selector. */
async function terminalActiveIn(win: Page, containerSelector: string): Promise<boolean> {
  return win.evaluate((sel: string) => {
    const el = document.activeElement;
    if (!el || !(el instanceof HTMLElement)) return false;
    if (!el.classList.contains('xterm-helper-textarea')) return false;
    return !!el.closest(sel);
  }, containerSelector);
}

/** Count of xterm helper textareas holding focus anywhere in the page (should never exceed 1). */
async function focusedTerminalCount(win: Page): Promise<number> {
  return win.evaluate(() => {
    const el = document.activeElement;
    return el instanceof HTMLElement && el.classList.contains('xterm-helper-textarea') ? 1 : 0;
  });
}

async function projectIdByName(win: Page, name: string): Promise<number> {
  return win.evaluate(async (n: string) => {
    const api = (window as unknown as { api: Api }).api;
    const { projects } = (await api.invoke('projects:list', undefined)) as unknown as {
      projects: Array<{ id: number; name: string }>;
    };
    const p = projects.find((x) => x.name === n);
    if (!p) throw new Error(`project not found in projects:list: ${n}`);
    return p.id;
  }, name);
}

test('probe: activeElement persists across a real window blur/focus cycle', async () => {
  // This is the empirical check for the documentation-grounding assumption
  // (plan §2, "activeElement persists across window blur"). Deliberately
  // uses the real BrowserWindow blur/focus (realBlurFocus), not the
  // dispatched-event refocus() the rest of this suite uses as its trigger
  // — a dispatched Event('focus') never itself moves activeElement, so it
  // would make this specific check vacuous. If this fails, the coordinator
  // design in Agent 1's plan changes (record on blur, decide on focus) —
  // report it rather than weakening this assertion.
  const { app, win, cleanup } = await launch(['alpha']);
  try {
    await openProject(win, 'alpha');
    await win.locator('.xterm').click();
    await win.keyboard.press('ControlOrMeta+f');
    const searchInput = win.locator('[data-testid="shell-search"] input');
    await expect(searchInput).toBeFocused({ timeout: 2000 });

    await realBlurFocus(app, win);

    await expect(searchInput, 'the find input keeps focus across a real OS blur/focus cycle').toBeFocused();
  } finally {
    await app.close();
    cleanup();
  }
});

test('AC1: body-focused window, single shell — refocus moves keyboard input into the terminal', async () => {
  const { app, win, cleanup } = await launch(['alpha']);
  try {
    await openProject(win, 'alpha');
    await blurToBody(win);
    const before = await win.evaluate(() => document.activeElement?.tagName);
    expect(before, 'positive control: activeElement really is <body> before refocus').toBe('BODY');

    await refocus(win);

    await expect.poll(() => terminalActiveIn(win, '[data-testid="shell-tab"]'), { timeout: 3000 }).toBe(true);

    await win.keyboard.type('hi');
    await win.keyboard.press('Enter');
    const { shells } = await win.evaluate(() => (window as unknown as { api: Api }).api
      .invoke('shells:alive-list', undefined) as unknown as Promise<{ shells: Array<{ projectId: number; projectName: string; shellIndex: number }> }>);
    const shell = shells.find((s) => s.projectName === 'alpha' && s.shellIndex === 0)!;
    await expect.poll(async () => {
      const snap = await win.evaluate((args: { projectId: number; shellIndex: number }) =>
        (window as unknown as { api: Api }).api.invoke('shells:snapshot', args) as unknown as Promise<{ output: string }>,
        { projectId: shell.projectId, shellIndex: shell.shellIndex });
      return snap.output;
    }, { timeout: 5000 }).toContain('echo: hi');
  } finally {
    await app.close();
    cleanup();
  }
});

test('AC2: a non-text control held focus — refocus still moves focus into the terminal', async () => {
  const { app, win, cleanup } = await launch(['alpha']);
  try {
    await openProject(win, 'alpha');
    await win.evaluate(() => (document.querySelector('[data-testid="tabbar-split"]') as HTMLElement | null)?.focus());
    const before = await win.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    expect(before, 'positive control: a non-text control really holds focus before refocus').toBe('tabbar-split');

    await refocus(win);

    await expect.poll(() => terminalActiveIn(win, '[data-testid="shell-tab"]'), { timeout: 3000 }).toBe(true);
  } finally {
    await app.close();
    cleanup();
  }
});

test('AC3: text-entry elements keep focus across refocus (find input, files editor, chat panel)', async () => {
  const { app, win, cleanup } = await launch(['alpha']);
  try {
    await openProject(win, 'alpha');

    // Terminal find input.
    await win.locator('.xterm').click();
    await win.keyboard.press('ControlOrMeta+f');
    const searchInput = win.locator('[data-testid="shell-search"] input');
    await expect(searchInput).toBeFocused();
    await refocus(win);
    await expect(searchInput, 'find input keeps focus').toBeFocused();
    await expect(terminalActiveIn(win, '[data-testid="shell-tab"]'), 'terminal did not steal focus from the find input').resolves.toBe(false);
    await win.keyboard.press('Escape');

    // Files tab editor textarea.
    await win.getByRole('button', { name: 'Files', exact: true }).click();
    await win.locator('[data-testid="file-entry"]', { hasText: 'notes.txt' }).click();
    await win.getByTestId('file-edit-toggle').click();
    const editorTextarea = win.locator('[data-testid="file-editor"] textarea');
    await editorTextarea.click();
    await expect(editorTextarea).toBeFocused();
    await refocus(win);
    await expect(editorTextarea, 'files editor keeps focus').toBeFocused();

    // ChatTab panel text-entry (metaproject login input — see file header:
    // the real composer is unreachable under METAIDE_TEST_MODE, no login stub).
    await win.getByTestId('ab-chat').click();
    const chatInput = win.getByTestId('mp-login-username');
    await expect(chatInput).toBeVisible({ timeout: 3000 });
    await chatInput.click();
    await expect(chatInput).toBeFocused();
    await refocus(win);
    await expect(chatInput, 'chat panel text-entry keeps focus').toBeFocused();
  } finally {
    await app.close();
    cleanup();
  }
});

test('AC4: an open overlay blocks auto-focus even with activeElement forced to <body>', async () => {
  const { app, win, cleanup } = await launch(['alpha']);
  try {
    await openProject(win, 'alpha');

    // Command palette (⌘⇧P).
    await win.keyboard.press('ControlOrMeta+Shift+P');
    const palette = win.locator('[data-testid="command-palette"]');
    await expect(palette).toBeVisible({ timeout: 2000 });
    await blurToBody(win);
    await refocus(win);
    await expect(palette, 'positive control: the overlay is still open in this state').toBeVisible();
    await expect(terminalActiveIn(win, '[data-testid="shell-tab"]'), 'no terminal took focus while the palette is open').resolves.toBe(false);
    await win.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);

    // File finder (⌘P).
    await win.keyboard.press('ControlOrMeta+p');
    const finder = win.locator('[data-testid="file-finder"]');
    await expect(finder).toBeVisible({ timeout: 2000 });
    await blurToBody(win);
    await refocus(win);
    await expect(finder, 'positive control: the overlay is still open in this state').toBeVisible();
    await expect(terminalActiveIn(win, '[data-testid="shell-tab"]'), 'no terminal took focus while the finder is open').resolves.toBe(false);
  } finally {
    await app.close();
    cleanup();
  }
});

test('AC5/AC7: split — last-used pane gets focus, mirrored, and only one terminal ever holds it', async () => {
  const { app, win, cleanup } = await launch(['alpha']);
  try {
    await openProject(win, 'alpha');
    await win.getByTestId('tabbar-split').click();
    await expect(win.getByTestId('split-right')).toBeVisible();

    // Use the right pane, then blur to body and refocus.
    await win.locator('[data-testid="split-right"] .xterm').click();
    await blurToBody(win);
    await refocus(win);
    await expect.poll(() => terminalActiveIn(win, '[data-testid="split-right"]'), { timeout: 3000 }).toBe(true);
    await expect(terminalActiveIn(win, '.split-left'), 'left pane was not called (no focus ping-pong)').resolves.toBe(false);
    expect(await focusedTerminalCount(win), 'exactly one terminal holds focus').toBe(1);

    // Mirror: use the left pane, then blur to body and refocus.
    await win.locator('.split-left .xterm').click();
    await blurToBody(win);
    await refocus(win);
    await expect.poll(() => terminalActiveIn(win, '.split-left'), { timeout: 3000 }).toBe(true);
    await expect(terminalActiveIn(win, '[data-testid="split-right"]'), 'right pane was not called (no focus ping-pong)').resolves.toBe(false);
    expect(await focusedTerminalCount(win), 'exactly one terminal holds focus').toBe(1);
  } finally {
    await app.close();
    cleanup();
  }
});

test('AC6: split open, nothing used yet — the left (primary) terminal gets focus', async () => {
  const { app, win, cleanup } = await launch(['alpha']);
  try {
    await openProject(win, 'alpha');
    await win.getByTestId('tabbar-split').click();
    await expect(win.getByTestId('split-right')).toBeVisible();

    await blurToBody(win);
    await refocus(win);

    await expect.poll(() => terminalActiveIn(win, '.split-left'), { timeout: 3000 }).toBe(true);
    await expect(terminalActiveIn(win, '[data-testid="split-right"]'), 'right pane (registered second) is not the default target').resolves.toBe(false);
  } finally {
    await app.close();
    cleanup();
  }
});

test('AC8: no terminal mounted on the Files tab — refocus is a no-op, and switching to Shell afterwards does not auto-focus (D4)', async () => {
  const { app, win, cleanup } = await launch(['alpha']);
  try {
    await openProject(win, 'alpha');
    await win.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(win.locator('[data-testid="shell-tab"]'), 'positive control: the terminal is genuinely unmounted on the Files tab').toHaveCount(0);

    const activeBefore = await win.evaluate(() => document.activeElement?.tagName);
    await refocus(win);
    const activeAfter = await win.evaluate(() => document.activeElement?.tagName);
    expect(activeAfter, 'no error and no focus change with nothing registered').toBe(activeBefore);

    // In-app switch back to Shell while the window is already focused: D4
    // says this must NOT auto-focus the terminal.
    await win.getByRole('button', { name: 'Shell', exact: true }).click();
    await expect(win.locator('[data-testid="shell-tab"] .xterm-screen'), 'positive control: the shell tab is rendered').toBeVisible({ timeout: 5000 });
    await expect(terminalActiveIn(win, '[data-testid="shell-tab"]'), 'in-app tab switch does not auto-focus the terminal (D4)').resolves.toBe(false);
  } finally {
    await app.close();
    cleanup();
  }
});

test('AC9/AC15: popout window — opens already focused, and the same window-focus rules apply to it', async () => {
  const { app, win, cleanup } = await launch(['alpha']);
  try {
    await openProject(win, 'alpha');
    const [popout] = await Promise.all([
      app.waitForEvent('window'),
      win.getByTestId('popout-shell').click(),
    ]);
    await popout.waitForLoadState('domcontentloaded');
    await expect(popout.locator('[data-testid="shell-tab"] .xterm-screen')).toBeVisible({ timeout: 8000 });

    // AC15: without clicking the terminal first, it is already the active element.
    await expect.poll(() => terminalActiveIn(popout, '[data-testid="shell-tab"]'), { timeout: 3000 })
      .toBe(true);

    // AC1 analog: force to <body>, refocus, terminal takes focus again.
    await blurToBody(popout);
    await refocus(popout);
    await expect.poll(() => terminalActiveIn(popout, '[data-testid="shell-tab"]'), { timeout: 3000 }).toBe(true);

    // AC3 analog: the popout's own find input keeps focus.
    await popout.locator('.xterm').click();
    await popout.keyboard.press('ControlOrMeta+f');
    const popoutSearch = popout.locator('[data-testid="shell-search"] input');
    await expect(popoutSearch).toBeFocused();
    await refocus(popout);
    await expect(popoutSearch, 'popout find input keeps focus').toBeFocused();
    await popout.keyboard.press('Escape');

    // AC8 analog: Files tab in the popout — refocus is a no-op.
    await popout.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(popout.locator('[data-testid="shell-tab"]'), 'positive control: terminal unmounted on popout Files tab').toHaveCount(0);
    await refocus(popout);
    await expect(popout.locator('[data-testid="shell-tab"]')).toHaveCount(0);
  } finally {
    await app.close();
    cleanup();
  }
});

test('AC10: notification click always switches project/shell, and honours D5 (overlay / text-entry wins over the request)', async () => {
  const { app, win, cleanup } = await launch(['alpha', 'beta']);
  try {
    await openProject(win, 'alpha');
    const betaId = await projectIdByName(win, 'beta');

    // Plain case: main window unfocused, request for a different project/shell.
    await app.evaluate(({ BrowserWindow }, payload) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      w.blur();
      w.show();
      w.focus();
      w.webContents.send('shell:focus-request', payload);
    }, { projectId: betaId, shellIndex: 0 });

    await expect.poll(() => win.title(), { timeout: 8000 }).toContain('beta');
    await expect(win.locator('[data-testid="shell-tab"] .xterm-screen'), 'Shell tab is active for the requested project').toBeVisible({ timeout: 8000 });
    await expect.poll(() => terminalActiveIn(win, '[data-testid="shell-tab"]'), { timeout: 3000 }).toBe(true);

    // D5 negative #1: a text-entry element held focus at blur time — the
    // switch still happens, but focus stays on the text-entry. Uses the
    // ChatTab panel's text-entry (see file header re: mp-login-username),
    // not the terminal find box: the requested project switch necessarily
    // unmounts the previously-selected project's ShellTab (and anything
    // inside it, including its find box), which is existing app behaviour
    // unrelated to this feature, so the find box cannot be the element that
    // "keeps focus" across this specific transition. ChatTab is not keyed
    // by project and stays mounted across the switch.
    await openProject(win, 'alpha');
    await win.getByTestId('ab-chat').click();
    const chatInput = win.getByTestId('mp-login-username');
    await expect(chatInput).toBeVisible({ timeout: 3000 });
    await chatInput.click();
    await expect(chatInput).toBeFocused();

    await app.evaluate(({ BrowserWindow }, payload) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      w.blur();
      w.show();
      w.focus();
      w.webContents.send('shell:focus-request', payload);
    }, { projectId: betaId, shellIndex: 0 });

    await expect.poll(() => win.title(), { timeout: 8000 }).toContain('beta');
    await expect(chatInput, 'the switch happens but the pre-existing text-entry keeps focus (D5)').toBeFocused();

    // D5 negative #2: an overlay (command palette) is open at blur time.
    await win.keyboard.press('Escape');
    await openProject(win, 'alpha');
    await win.keyboard.press('ControlOrMeta+Shift+P');
    const palette = win.locator('[data-testid="command-palette"]');
    await expect(palette).toBeVisible({ timeout: 2000 });

    await app.evaluate(({ BrowserWindow }, payload) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      w.blur();
      w.show();
      w.focus();
      w.webContents.send('shell:focus-request', payload);
    }, { projectId: betaId, shellIndex: 0 });

    await expect.poll(() => win.title(), { timeout: 8000 }).toContain('beta');
    await expect(palette, 'positive control: the overlay is still open').toBeVisible();
    await expect(terminalActiveIn(win, '[data-testid="shell-tab"]'), 'the switch happens but no terminal steals focus while an overlay is open (D5)').resolves.toBe(false);
  } finally {
    await app.close();
    cleanup();
  }
});

test('AC12: focus moves inside an already-focused window never triggers auto-focus (plus the approximated activating click)', async () => {
  const { app, win, cleanup } = await launch(['alpha']);
  try {
    await openProject(win, 'alpha');
    await win.locator('.xterm').click();
    await expect.poll(() => terminalActiveIn(win, '[data-testid="shell-tab"]'), { timeout: 3000 }).toBe(true);

    // Window is already focused: clicking a sidebar button moves focus
    // in-page, with no window `focus` event in between.
    await win.getByTestId('activity-bar').click({ position: { x: 20, y: 400 } });
    await expect(terminalActiveIn(win, '[data-testid="shell-tab"]'), 'an in-window click never re-steals focus into the terminal').resolves.toBe(false);

    // Approximated activating click (see file header: real OS ordering is
    // not reproducible under Playwright). Force to a text-entry, blur the
    // window, click it (simulating the activating click), then focus the
    // window — the text-entry must still hold focus.
    await win.getByTestId('ab-chat').click();
    const chatInput = win.getByTestId('mp-login-username');
    await expect(chatInput).toBeVisible({ timeout: 3000 });
    const handle = await app.browserWindow(win);
    await handle.evaluate((w) => w.blur());
    await chatInput.click();
    await expect(chatInput).toBeFocused();
    await handle.evaluate((w) => w.focus());
    await expect(chatInput, 'the activating click keeps its element focused; the terminal does not take it').toBeFocused();
  } finally {
    await app.close();
    cleanup();
  }
});
