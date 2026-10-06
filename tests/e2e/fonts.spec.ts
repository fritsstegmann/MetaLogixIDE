import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  TERMINAL_FONT_FALLBACK,
  UI_FONT_FALLBACK,
  type FontSettingKey,
} from '../../src/shared/font-settings';
import { FONT_COPY, FONT_TEST_IDS, UI_FONT_CSS_PROPERTY } from '../../src/renderer/fonts/font-contract';

const PROJECT = 'fonts-e2e';
const E2E_TIMEOUT = 10_000;

type Api = { invoke: (channel: string, request: unknown) => Promise<unknown> };
type ResizeCall = { projectId: number; shellIndex: number; cols: number; rows: number };
type InvokeHandler = (event: unknown, request: unknown) => unknown;
type IpcMainWithHandlers = { _invokeHandlers?: Map<string, InvokeHandler> };
type RendererWindow = Window & { api: Api };
type ResizeGlobals = typeof globalThis & { __fontResizeCalls: ResizeCall[] };
type TermProbe = {
  key: 'left' | 'right' | 'single';
  token: number;
  fontFamily: string;
  fontSize: number;
  cols: number;
  rows: number;
  bufferLength: number;
  selection: string;
  textareaValue: string;
  unicodeVersion: string;
  screen: string;
};

interface Harness {
  app: ElectronApplication;
  win: Page;
  home: string;
  root: string;
  projectDir: string;
  close: (remove?: boolean) => Promise<void>;
}

function createFixture(): { home: string; root: string; projectDir: string } {
  const home = mkdtempSync(join(tmpdir(), 'metaide-font-home-'));
  const root = mkdtempSync(join(tmpdir(), 'metaide-font-root-'));
  const projectDir = join(root, PROJECT);
  mkdirSync(projectDir);
  mkdirSync(join(projectDir, '.git'));
  writeFileSync(
    join(projectDir, 'sample.ts'),
    Array.from({ length: 100 }, (_, index) => `const line${index + 1} = "font editor state ${index + 1}";`).join('\n'),
  );
  writeFileSync(
    join(projectDir, 'guide.md'),
    '# Font prose\n\nOrdinary rendered prose inherits the UI family.\n\nInline `const mono = true` stays monospaced.\n\n```ts\nconst block = true;\n```\n',
  );
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

async function setting(win: Page, key: FontSettingKey): Promise<string | null> {
  return win.evaluate(async (settingKey: FontSettingKey) => {
    const rendererWindow = window as unknown as RendererWindow;
    const response = await rendererWindow.api.invoke('settings:get', { key: settingKey }) as { value: string | null };
    return response.value;
  }, key);
}

function fontInput(win: Page, key: FontSettingKey) {
  return win.getByTestId(key === 'ui_font_family' ? FONT_TEST_IDS.uiInput : FONT_TEST_IDS.terminalInput);
}

function fontReset(win: Page, key: FontSettingKey) {
  return win.getByTestId(key === 'ui_font_family' ? FONT_TEST_IDS.uiReset : FONT_TEST_IDS.terminalReset);
}

function fontStatus(win: Page, key: FontSettingKey) {
  return win.getByTestId(key === 'ui_font_family' ? FONT_TEST_IDS.uiStatus : FONT_TEST_IDS.terminalStatus);
}

async function setFontThroughUi(win: Page, key: FontSettingKey, value: string): Promise<void> {
  const input = fontInput(win, key);
  await input.fill(value);
  await input.press('Enter');
  await expect.poll(() => setting(win, key), { timeout: E2E_TIMEOUT }).toBe(value.trim());
}

type FontQueryGlobals = { __fontQueryCount?: number; __releaseFontQuery?: () => void };

/**
 * Replaces `window.queryLocalFonts`. Every call is counted in
 * `__fontQueryCount` (see `fontQueryCount`). `deferred` answers with
 * `families` only once `releaseFontQuery` runs, so a test can act while
 * discovery is still pending.
 */
async function mockLocalFonts(
  win: Page,
  behavior:
    | { kind: 'success'; families: string[] }
    | { kind: 'deferred'; families: string[] }
    | { kind: 'denied' }
    | { kind: 'unsupported' },
): Promise<void> {
  await win.evaluate((mock) => {
    const globals = window as unknown as Window & FontQueryGlobals;
    if (mock.kind === 'unsupported') {
      Object.defineProperty(window, 'queryLocalFonts', { configurable: true, value: undefined });
      return;
    }
    const metadata = (): Array<{ family: string }> => (mock.kind === 'denied' ? [] : mock.families.map((family) => ({ family })));
    const query = async (): Promise<Array<{ family: string }>> => {
      globals.__fontQueryCount = (globals.__fontQueryCount ?? 0) + 1;
      if (mock.kind === 'denied') throw new DOMException('Font access denied by test', 'NotAllowedError');
      if (mock.kind === 'deferred') {
        await new Promise<void>((release) => { globals.__releaseFontQuery = release; });
      }
      return metadata();
    };
    Object.defineProperty(window, 'queryLocalFonts', { configurable: true, value: query });
  }, behavior);
}

/** How many times the page has called `queryLocalFonts` since the first mock. */
async function fontQueryCount(win: Page): Promise<number> {
  return win.evaluate(() => (window as unknown as Window & FontQueryGlobals).__fontQueryCount ?? 0);
}

/** Lets a pending `deferred` discovery answer. */
async function releaseFontQuery(win: Page): Promise<void> {
  await win.evaluate(() => {
    const globals = window as unknown as Window & FontQueryGlobals;
    if (!globals.__releaseFontQuery) throw new Error('no deferred font query is pending');
    globals.__releaseFontQuery();
    delete globals.__releaseFontQuery;
  });
}

/** The open option list of one font combobox ("System default", installed families, "Use …"). */
function fontOptions(win: Page, key: FontSettingKey): Locator {
  const label = key === 'ui_font_family' ? FONT_COPY.uiLabel : FONT_COPY.terminalLabel;
  return win.getByRole('listbox', { name: `${label} options`, exact: true });
}

/** Finds xterm Terminal refs through the same React-fiber hook precedent as claude-tab-remount.spec.ts. */
async function terminalProbes(win: Page): Promise<TermProbe[]> {
  return win.evaluate(() => {
    type Line = { translateToString: (trim: boolean) => string };
    type Buffer = {
      baseY: number;
      viewportY: number;
      length: number;
      getLine: (row: number) => Line | undefined;
    };
    type Term = {
      cols: number;
      rows: number;
      options: { fontFamily?: string; fontSize?: number };
      buffer: { active: Buffer };
      textarea?: HTMLTextAreaElement;
      unicode: { activeVersion: string };
      getSelection: () => string;
    };
    type Hook = { memoizedState: unknown; next: Hook | null };
    type Fiber = { tag: number; memoizedState: unknown; return: Fiber | null };
    type ProbeGlobals = { __fontTermIds?: WeakMap<object, number>; __fontNextTermId?: number };
    const globals = window as unknown as Window & ProbeGlobals;
    globals.__fontTermIds ??= new WeakMap<object, number>();
    globals.__fontNextTermId ??= 1;
    const isTerm = (value: unknown): value is Term => {
      if (!value || typeof value !== 'object') return false;
      const candidate = value as Partial<Term>;
      return !!candidate.buffer?.active && typeof candidate.cols === 'number' && typeof candidate.getSelection === 'function';
    };
    const findTerm = (node: HTMLElement): Term | null => {
      let element: HTMLElement | null = node;
      let fiber: Fiber | null = null;
      while (element && !fiber) {
        const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
        if (key) fiber = (element as unknown as Record<string, Fiber>)[key] ?? null;
        element = element.parentElement;
      }
      for (let current = fiber; current; current = current.return) {
        if (current.tag !== 0) continue;
        for (let hook = current.memoizedState as Hook | null; hook; hook = hook.next) {
          const ref = hook.memoizedState as { current?: unknown } | null;
          if (ref && typeof ref === 'object' && 'current' in ref && isTerm(ref.current)) return ref.current;
        }
      }
      return null;
    };
    return [...document.querySelectorAll<HTMLElement>('.xterm')]
      .filter((node) => node.offsetParent !== null)
      .map((node) => {
        const term = findTerm(node);
        if (!term) throw new Error('visible xterm has no discoverable Terminal ref');
        const ids = globals.__fontTermIds;
        if (!ids) throw new Error('terminal identity registry unavailable');
        let token = ids.get(term);
        if (token === undefined) {
          token = globals.__fontNextTermId ?? 1;
          globals.__fontNextTermId = token + 1;
          ids.set(term, token);
        }
        const buffer = term.buffer.active;
        const visible: string[] = [];
        for (let row = 0; row < term.rows; row += 1) {
          visible.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
        }
        return {
          key: node.closest('[data-testid="split-right"]') ? 'right' : node.closest('.split-left') ? 'left' : 'single',
          token,
          fontFamily: term.options.fontFamily ?? '',
          fontSize: term.options.fontSize ?? 0,
          cols: term.cols,
          rows: term.rows,
          bufferLength: buffer.length,
          selection: term.getSelection(),
          textareaValue: term.textarea?.value ?? '',
          unicodeVersion: term.unicode.activeVersion,
          screen: visible.join('\n'),
        } satisfies TermProbe;
      });
  });
}

async function selectEveryTerminal(win: Page): Promise<void> {
  await win.evaluate(() => {
    type Term = { buffer: object; selectAll: () => void };
    type Hook = { memoizedState: unknown; next: Hook | null };
    type Fiber = { tag: number; memoizedState: unknown; return: Fiber | null };
    const isTerm = (value: unknown): value is Term => {
      if (!value || typeof value !== 'object' || !('buffer' in value)) return false;
      const candidate = value as Partial<Term>;
      return typeof candidate.selectAll === 'function';
    };
    terminalLoop: for (const node of document.querySelectorAll<HTMLElement>('.xterm')) {
      if (node.offsetParent === null) continue;
      let element: HTMLElement | null = node;
      let fiber: Fiber | null = null;
      while (element && !fiber) {
        const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
        if (key) fiber = (element as unknown as Record<string, Fiber>)[key] ?? null;
        element = element.parentElement;
      }
      for (let current = fiber; current; current = current.return) {
        if (current.tag !== 0) continue;
        for (let hook = current.memoizedState as Hook | null; hook; hook = hook.next) {
          const ref = hook.memoizedState as { current?: unknown } | null;
          if (ref && typeof ref === 'object' && 'current' in ref && isTerm(ref.current)) {
            ref.current.selectAll();
            continue terminalLoop;
          }
        }
      }
    }
  });
}

async function installResizeRecorder(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const ipcMainWithHandlers = ipcMain as unknown as IpcMainWithHandlers;
    const original = ipcMainWithHandlers._invokeHandlers?.get('shells:resize');
    if (!original) throw new Error('shells:resize handler unavailable');
    const globals = globalThis as ResizeGlobals;
    globals.__fontResizeCalls = [];
    ipcMain.removeHandler('shells:resize');
    ipcMain.handle('shells:resize', (event, request: ResizeCall) => {
      globals.__fontResizeCalls.push({ ...request });
      return original(event, request);
    });
  });
}

async function resizeCalls(app: ElectronApplication): Promise<ResizeCall[]> {
  return app.evaluate(() => {
    const globals = globalThis as ResizeGlobals;
    return [...globals.__fontResizeCalls];
  });
}

async function shellOutput(win: Page, shellIndex = 0): Promise<string> {
  return win.evaluate(async ({ projectName, index }) => {
    const rendererWindow = window as unknown as RendererWindow;
    const { shells } = await rendererWindow.api.invoke('shells:alive-list', undefined) as {
      shells: Array<{ projectId: number; projectName: string; shellIndex: number }>;
    };
    const shell = shells.find((entry) => entry.projectName === projectName && entry.shellIndex === index);
    if (!shell) return '';
    const snapshot = await rendererWindow.api.invoke('shells:snapshot', {
      projectId: shell.projectId,
      shellIndex: shell.shellIndex,
    }) as { output: string };
    return snapshot.output;
  }, { projectName: PROJECT, index: shellIndex });
}

async function overrideFontReadiness(win: Page, mode: 'reject' | 'timeout' | 'restore'): Promise<void> {
  await win.evaluate((nextMode) => {
    type Globals = { __originalFontLoad?: FontFaceSet['load'] };
    const globals = window as unknown as Window & Globals;
    globals.__originalFontLoad ??= document.fonts.load.bind(document.fonts);
    const replacement = nextMode === 'restore'
      ? globals.__originalFontLoad
      : nextMode === 'reject'
        ? (() => Promise.reject(new Error('font load rejected by E2E'))) as FontFaceSet['load']
        : (() => new Promise<FontFace[]>(() => {})) as FontFaceSet['load'];
    Object.defineProperty(document.fonts, 'load', { configurable: true, value: replacement });
  }, mode);
}

async function exerciseCopySanitizer(win: Page): Promise<{ selected: string; copied: string }> {
  return win.evaluate(async () => {
    type Line = { translateToString: (trim: boolean) => string };
    type Term = {
      buffer: { active: { length: number; getLine: (row: number) => Line | undefined } };
      write: (data: string, callback?: () => void) => void;
      select: (column: number, row: number, length: number) => void;
      getSelection: () => string;
    };
    type Hook = { memoizedState: unknown; next: Hook | null };
    type Fiber = { tag: number; memoizedState: unknown; return: Fiber | null };
    const node = document.querySelector<HTMLElement>('.xterm');
    if (!node) throw new Error('no xterm');
    let element: HTMLElement | null = node;
    let fiber: Fiber | null = null;
    while (element && !fiber) {
      const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
      if (key) fiber = (element as unknown as Record<string, Fiber>)[key] ?? null;
      element = element.parentElement;
    }
    let term: Term | null = null;
    for (let current = fiber; current && !term; current = current.return) {
      if (current.tag !== 0) continue;
      for (let hook = current.memoizedState as Hook | null; hook && !term; hook = hook.next) {
        const ref = hook.memoizedState as { current?: unknown } | null;
        const value = ref?.current as Partial<Term> | undefined;
        if (value?.buffer && typeof value.write === 'function' && typeof value.select === 'function') term = value as Term;
      }
    }
    if (!term) throw new Error('Terminal ref unavailable');
    const foundTerm = term;
    const marker = `COPY-A\uE0B0COPY-B`;
    await new Promise<void>((resolveWrite) => foundTerm.write(`\r\n${marker}\r\n`, resolveWrite));
    let row = -1;
    let column = -1;
    for (let index = 0; index < foundTerm.buffer.active.length; index += 1) {
      const text = foundTerm.buffer.active.getLine(index)?.translateToString(false) ?? '';
      const found = text.indexOf('COPY-A');
      if (found >= 0) { row = index; column = found; }
    }
    if (row < 0) throw new Error('copy marker did not reach xterm buffer');
    term.select(column, row, marker.length);
    const selected = term.getSelection();
    const transfer = new DataTransfer();
    node.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: transfer }));
    return { selected, copied: transfer.getData('text/plain') };
  });
}

function latestCallsByShell(calls: ResizeCall[]): Map<number, ResizeCall> {
  const latest = new Map<number, ResizeCall>();
  for (const call of calls) latest.set(call.shellIndex, call);
  return latest;
}

test.describe.serial('configurable UI and terminal fonts', () => {
  test('AC40-AC42 (fonts spec AC2, AC4-AC7, AC9-AC10): independent Interface and Terminal comboboxes support manual keyboard entry, validation, System default, and safe literal names', async () => {
    const harness = await launchHarness();
    try {
      const { win } = harness;
      await mockLocalFonts(win, { kind: 'success', families: [] });
      await openSettings(win);
      const modal = win.getByTestId('settings-modal');
      // AC40: the labels are literal copy, not read back from the contract under test.
      const ui = win.getByLabel('Interface', { exact: true });
      const terminal = win.getByLabel('Terminal', { exact: true });

      await expect(ui).toHaveCount(1);
      await expect(terminal).toHaveCount(1);
      await expect(ui).toHaveAttribute('role', 'combobox');
      await expect(terminal).toHaveAttribute('role', 'combobox');
      await expect(fontInput(win, 'ui_font_family')).toHaveValue('');
      await expect(fontInput(win, 'terminal_font_family')).toHaveValue('');
      await expect(ui).toHaveAttribute('placeholder', FONT_COPY.defaultValue);

      await ui.focus();
      await expect(ui).toBeFocused();
      await expect(ui).toHaveAttribute('aria-expanded', 'true');

      await ui.fill('  Trimmed Ω Family  ');
      await expect(fontOptions(win, 'ui_font_family').getByRole('option', { name: FONT_COPY.customOption('Trimmed Ω Family'), exact: true })).toBeVisible();
      await ui.press('Enter');
      await expect.poll(() => setting(win, 'ui_font_family')).toBe('Trimmed Ω Family');
      await expect(ui).toHaveValue('Trimmed Ω Family');

      for (const invalid of ['bad\u0000family', '😀'.repeat(257)]) {
        await ui.fill(invalid);
        await ui.press('Enter');
        await expect.poll(() => setting(win, 'ui_font_family')).toBe('Trimmed Ω Family');
        await expect(modal.getByRole('alert')).toBeVisible();
      }

      const safe = `Font "quoted", semi; slash\\ braces{} Ω`;
      const colorBefore = await modal.evaluate((element) => getComputedStyle(element).color);
      await setFontThroughUi(win, 'ui_font_family', safe);
      expect(await setting(win, 'ui_font_family')).toBe(safe);
      expect(await modal.evaluate((element) => getComputedStyle(element).color)).toBe(colorBefore);
      const cssValue = await win.locator('html').evaluate((element, property) => element.style.getPropertyValue(property), UI_FONT_CSS_PROPERTY);
      expect(cssValue).toContain('quoted');
      expect(cssValue).toContain(UI_FONT_FALLBACK);

      // The "System default" option replaces the old Reset button.
      await setFontThroughUi(win, 'terminal_font_family', 'Independent Terminal');
      await ui.click();
      await fontReset(win, 'ui_font_family').click();
      await expect.poll(() => setting(win, 'ui_font_family')).toBeNull();
      expect(await setting(win, 'terminal_font_family')).toBe('Independent Terminal');
      await expect(ui).toHaveValue('');
      await expect(terminal).toHaveValue('Independent Terminal');

      // AC42: an empty or whitespace-only field saves System default. This
      // replaces the fonts-spec AC3 rejection that the '   ' case used to assert.
      await terminal.fill('   ');
      await terminal.press('Enter');
      await expect.poll(() => setting(win, 'terminal_font_family')).toBeNull();
      await expect(terminal).toHaveValue('');
      for (const blank of ['', '   ']) {
        await setFontThroughUi(win, 'ui_font_family', 'Blank Probe');
        await ui.fill(blank);
        await ui.press('Enter');
        await expect.poll(() => setting(win, 'ui_font_family'), { message: `${JSON.stringify(blank)} saves System default` }).toBeNull();
        await expect(ui).toHaveValue('');
        await expect(modal.getByRole('alert'), `${JSON.stringify(blank)} is not a validation error`).toHaveCount(0);
      }
    } finally {
      await harness.close();
    }
  });

  test('installed font list filters, previews, and independently persists keyboard selections without closing Settings', async () => {
    const harness = await launchHarness();
    try {
      const { win } = harness;
      await mockLocalFonts(win, {
        kind: 'success',
        families: ['zeta Mono', 'Alpha Font', 'alpha font', 'Comma, Family', 'Éclair Mono', 'ZETA MONO'],
      });
      await openSettings(win);
      const modal = win.getByTestId('settings-modal');
      await setFontThroughUi(win, 'ui_font_family', 'Missing UI Family');
      await setFontThroughUi(win, 'terminal_font_family', 'Missing Font Family');
      await expect(fontStatus(win, 'ui_font_family')).toHaveText(FONT_COPY.unavailable);
      await expect(fontStatus(win, 'terminal_font_family')).toHaveText(FONT_COPY.unavailable);
      const unavailablePreviewStack = await modal.getByLabel(`${FONT_COPY.terminalLabel} preview`)
        .evaluate((element) => getComputedStyle(element).fontFamily);
      expect(unavailablePreviewStack).toContain('Missing Font Family');
      expect(unavailablePreviewStack).toContain(TERMINAL_FONT_FALLBACK);

      // Opening the field lists System default plus every installed family, each in its own face.
      const ui = fontInput(win, 'ui_font_family');
      await ui.click();
      const uiOptions = fontOptions(win, 'ui_font_family');
      await expect(uiOptions.getByRole('option')).toHaveCount(5);
      // The row's text includes an aria-hidden ✓ glyph, so match the accessible name.
      await expect(uiOptions.getByRole('option').first()).toHaveAccessibleName('System default');
      for (const family of ['Alpha Font', 'Comma, Family', 'Éclair Mono', 'zeta Mono']) {
        const row = uiOptions.getByRole('option', { name: family, exact: true });
        await expect(row).toBeVisible();
        await expect(row.getByText(family, { exact: true })).toHaveCSS('font-family', new RegExp(family));
      }

      // Typing filters case-insensitively and offers the typed name as a literal.
      await ui.fill('  ÉCL  ');
      await expect(uiOptions.getByRole('option', { name: 'Éclair Mono', exact: true })).toBeVisible();
      await expect(uiOptions.getByRole('option', { name: 'Alpha Font', exact: true })).toHaveCount(0);
      await expect(uiOptions.getByRole('option', { name: FONT_COPY.customOption('ÉCL'), exact: true })).toBeVisible();
      await ui.fill('No such installed family');
      await expect(uiOptions.getByRole('option')).toHaveCount(2);
      expect(await setting(win, 'ui_font_family')).toBe('Missing UI Family');
      await ui.fill('écl');
      const eclairId = await uiOptions.getByRole('option', { name: 'Éclair Mono', exact: true }).getAttribute('id');
      await expect(ui, 'typing highlights the first match').toHaveAttribute('aria-activedescendant', eclairId ?? '');
      await ui.press('Enter');
      await expect.poll(() => setting(win, 'ui_font_family')).toBe('Éclair Mono');
      await expect(ui).toHaveValue('Éclair Mono');
      await expect(fontStatus(win, 'ui_font_family')).toHaveText('');
      await expect(uiOptions).toHaveCount(0);
      expect(await setting(win, 'terminal_font_family')).toBe('Missing Font Family');

      const terminal = fontInput(win, 'terminal_font_family');
      await terminal.fill('ZETA');
      const terminalOptions = fontOptions(win, 'terminal_font_family');
      await expect(terminalOptions.getByRole('option', { name: 'zeta Mono', exact: true })).toBeVisible();
      await terminal.press('Enter');
      await expect.poll(() => setting(win, 'terminal_font_family')).toBe('zeta Mono');
      await expect(terminal).toHaveValue('zeta Mono');
      await expect(fontStatus(win, 'terminal_font_family')).toHaveText('');
      expect(await setting(win, 'ui_font_family')).toBe('Éclair Mono');

      // Arrow keys move through the list; Escape closes it, restores the saved name, and keeps Settings open.
      await terminal.press('ArrowDown');
      await expect(terminalOptions).toBeVisible();
      await terminal.fill('Alpha');
      await terminal.press('Escape');
      await expect(terminalOptions).toHaveCount(0);
      await expect(terminal).toHaveValue('zeta Mono');
      await expect(terminal).toBeFocused();
      await expect(modal).toBeVisible();
      expect(await setting(win, 'terminal_font_family')).toBe('zeta Mono');

      // The same for the Interface list.
      await ui.click();
      await expect(uiOptions).toBeVisible();
      await ui.fill('Comma');
      await ui.press('Escape');
      await expect(uiOptions).toHaveCount(0);
      await expect(ui).toHaveValue('Éclair Mono');
      await expect(ui).toBeFocused();
      await expect(modal).toBeVisible();
      expect(await setting(win, 'ui_font_family')).toBe('Éclair Mono');

      await win.getByTestId('settings-done').click();
      await openSettings(win);
      await expect(fontInput(win, 'ui_font_family')).toHaveValue('Éclair Mono');
      await expect(fontInput(win, 'terminal_font_family')).toHaveValue('zeta Mono');

      // AC46: ArrowDown/ArrowUp move the highlight and Enter saves the highlighted option.
      const terminalAgain = fontInput(win, 'terminal_font_family');
      const reopened = fontOptions(win, 'terminal_font_family');
      await terminalAgain.focus();
      await expect(reopened.getByRole('option')).toHaveCount(5);
      const start = await terminalAgain.getAttribute('aria-activedescendant');
      expect(start, 'an open list has a highlight').toBeTruthy();
      await terminalAgain.press('ArrowDown');
      await expect(terminalAgain, 'ArrowDown moves the highlight').not.toHaveAttribute('aria-activedescendant', start ?? '');
      const down = await terminalAgain.getAttribute('aria-activedescendant');
      await terminalAgain.press('ArrowUp');
      await expect(terminalAgain, 'ArrowUp moves it back').toHaveAttribute('aria-activedescendant', start ?? '');
      await terminalAgain.press('ArrowDown');
      await expect(terminalAgain).toHaveAttribute('aria-activedescendant', down ?? '');
      let highlighted: string | undefined;
      for (const name of ['System default', 'Alpha Font', 'Comma, Family', 'Éclair Mono', 'zeta Mono']) {
        if (await reopened.getByRole('option', { name, exact: true }).getAttribute('id') === down) highlighted = name;
      }
      if (highlighted === undefined) throw new Error(`highlight ${down} is not one of the five options`);
      expect(highlighted, 'input state: the highlight is not the saved font, so Enter must change it').not.toBe('zeta Mono');
      await terminalAgain.press('Enter');
      await expect.poll(() => setting(win, 'terminal_font_family'))
        .toBe(highlighted === 'System default' ? null : highlighted);
      expect(await setting(win, 'ui_font_family')).toBe('Éclair Mono');
    } finally {
      await harness.close();
    }
  });

  test('denied font discovery retries from the list without leaving Settings and keeps manual entry and System default usable', async () => {
    const harness = await launchHarness();
    try {
      const { win } = harness;
      await mockLocalFonts(win, { kind: 'denied' });
      await openSettings(win);
      const modal = win.getByTestId('settings-modal');
      await setFontThroughUi(win, 'terminal_font_family', 'Manual While Denied');
      const terminal = fontInput(win, 'terminal_font_family');
      await terminal.click();
      await expect(fontOptions(win, 'terminal_font_family').getByRole('status')).toHaveText(FONT_COPY.discoveryDenied);
      await expect(fontStatus(win, 'terminal_font_family')).toHaveText(FONT_COPY.unknown);

      // AC45: a failure shows Retry, and Retry requests discovery again.
      const deniedRetry = fontOptions(win, 'terminal_font_family').getByRole('button', { name: 'Retry', exact: true });
      await expect(deniedRetry).toBeVisible();
      const deniedQueries = await fontQueryCount(win);
      expect(deniedQueries, 'input state: the denied discovery was requested').toBeGreaterThan(0);
      await deniedRetry.click();
      await expect.poll(() => fontQueryCount(win), { message: 'Retry requests discovery again' }).toBeGreaterThan(deniedQueries);
      await expect(fontOptions(win, 'terminal_font_family').getByRole('status')).toHaveText(FONT_COPY.discoveryDenied);
      await fontReset(win, 'terminal_font_family').click();
      await expect.poll(() => setting(win, 'terminal_font_family')).toBeNull();
      // The pointer still rests where System default was clicked, so the reopened
      // list renders under it. AC43: the typed text, not the hovered row, decides.
      await terminal.fill('Retry Mono');
      const retryCustom = fontOptions(win, 'terminal_font_family').getByRole('option', { name: 'Use “Retry Mono”', exact: true });
      await expect(retryCustom).toBeVisible();
      await expect(terminal, 'typing highlights the custom option, not the row under a resting pointer')
        .toHaveAttribute('aria-activedescendant', (await retryCustom.getAttribute('id')) ?? '');
      await terminal.press('Enter');
      await expect.poll(() => setting(win, 'terminal_font_family'), { timeout: E2E_TIMEOUT }).toBe('Retry Mono');

      await mockLocalFonts(win, { kind: 'success', families: ['Retry Mono', 'Another Family'] });
      await expect(terminal, 'input state: the list is closed before it is reopened').toHaveAttribute('aria-expanded', 'false');
      const beforeReopen = await fontQueryCount(win);
      await terminal.click();
      const terminalOptions = fontOptions(win, 'terminal_font_family');
      await expect(terminalOptions.getByRole('option')).toHaveCount(3);
      expect(await fontQueryCount(win), 'AC45: reopening the list after a failure requests discovery again').toBeGreaterThan(beforeReopen);
      await expect(fontStatus(win, 'terminal_font_family')).toHaveText('');
      await expect(terminalOptions.getByRole('status')).toHaveCount(0);
      await expect(modal).toBeVisible();
      await expect(terminal).toHaveValue('Retry Mono');
      await terminal.press('Escape');

      await win.getByTestId('settings-done').click();
      await mockLocalFonts(win, { kind: 'unsupported' });
      await openSettings(win);
      await setFontThroughUi(win, 'ui_font_family', 'Manual Unsupported');
      await fontInput(win, 'ui_font_family').click();
      await expect(fontOptions(win, 'ui_font_family').getByRole('status')).toHaveText(FONT_COPY.discoveryUnsupported);
      await expect(fontStatus(win, 'ui_font_family')).toHaveText(FONT_COPY.unknown);
      await expect(fontReset(win, 'ui_font_family')).toBeVisible();

      // The Retry button inside the list re-queries without closing it.
      await mockLocalFonts(win, { kind: 'success', families: ['Manual Unsupported'] });
      await fontOptions(win, 'ui_font_family').getByRole('button', { name: FONT_COPY.retry, exact: true }).click();
      await expect(fontOptions(win, 'ui_font_family').getByRole('option', { name: 'Manual Unsupported', exact: true })).toBeVisible();
      await expect(fontStatus(win, 'ui_font_family')).toHaveText('');
    } finally {
      await harness.close();
    }
  });

  test('AC45: discovery runs on the first focus or open of a list, once per Settings session after a success', async () => {
    const harness = await launchHarness();
    try {
      const { win } = harness;
      await mockLocalFonts(win, { kind: 'success', families: ['Alpha Sans', 'Beta Sans', 'Gamma Mono'] });
      await openSettings(win);
      const ui = fontInput(win, 'ui_font_family');
      const terminal = fontInput(win, 'terminal_font_family');
      await expect(ui).toBeVisible();
      expect(await fontQueryCount(win), 'opening Settings alone requests nothing').toBe(0);

      // Focus alone, without a click or typing, requests discovery.
      await ui.focus();
      await expect.poll(() => fontQueryCount(win), { message: 'first focus requests discovery' }).toBe(1);
      await expect(fontOptions(win, 'ui_font_family').getByRole('option')).toHaveCount(4);

      // After a success neither list asks again in this session.
      await ui.press('Escape');
      await expect(fontOptions(win, 'ui_font_family')).toHaveCount(0);
      await terminal.click();
      await expect(fontOptions(win, 'terminal_font_family').getByRole('option'), 'the Terminal list shows the discovered families').toHaveCount(4);
      await terminal.press('Escape');
      await ui.click();
      await expect(fontOptions(win, 'ui_font_family').getByRole('option')).toHaveCount(4);
      expect(await fontQueryCount(win), 'no second request after a success').toBe(1);

      // A new Settings session starts over; opening a list by click requests again.
      await ui.press('Escape');
      await win.getByTestId('settings-done').click();
      await openSettings(win);
      expect(await fontQueryCount(win)).toBe(1);
      await fontInput(win, 'terminal_font_family').click();
      await expect.poll(() => fontQueryCount(win), { message: 'a new session requests discovery again' }).toBe(2);
      await expect(fontOptions(win, 'terminal_font_family').getByRole('option')).toHaveCount(4);
    } finally {
      await harness.close();
    }
  });

  test('AC43-AC44: Enter keeps the current font on an unmodified field after discovery lands, and saves exactly what was typed into a closed list', async () => {
    const harness = await launchHarness();
    try {
      const { win } = harness;
      const families = ['Alpha Sans', 'Beta Sans', 'Gamma Mono'];
      const ui = fontInput(win, 'ui_font_family');
      const uiOptions = fontOptions(win, 'ui_font_family');

      // Save a family, then start a fresh Settings session so discovery is idle again.
      await mockLocalFonts(win, { kind: 'deferred', families });
      await openSettings(win);
      await setFontThroughUi(win, 'ui_font_family', 'Gamma Mono');
      await win.getByTestId('settings-done').click();

      // AC44 (gate B2 trigger 2): focus starts discovery; it lands while the list is
      // open; Enter on the untouched field must not fall back to System default.
      await mockLocalFonts(win, { kind: 'deferred', families });
      await openSettings(win);
      await expect(ui).toHaveValue('Gamma Mono');
      const queriesBefore = await fontQueryCount(win);
      await ui.focus();
      await expect(uiOptions).toBeVisible();
      await expect.poll(() => fontQueryCount(win)).toBe(queriesBefore + 1);
      await expect(uiOptions.getByRole('option', { name: 'Gamma Mono', exact: true }), 'input state: discovery is still pending').toHaveCount(0);
      await releaseFontQuery(win);
      await expect(uiOptions.getByRole('option')).toHaveCount(4);
      await expect(uiOptions.getByRole('option', { name: 'Gamma Mono', exact: true })).toHaveAttribute('aria-selected', 'true');
      await ui.press('Enter');
      // Ordering barrier: this save is issued after anything the Enter issued, so once
      // it lands, a wrong save from the Enter would already be stored.
      await setFontThroughUi(win, 'terminal_font_family', 'Barrier Terminal');
      expect(await setting(win, 'ui_font_family'), 'Enter on an unmodified field keeps the current font').toBe('Gamma Mono');
      await expect(ui).toHaveValue('Gamma Mono');

      // AC43 (gate B2 trigger 1): one input event into a closed list opens it with the
      // first matching family highlighted, and Enter saves that family. A stale
      // highlight would land on "Use “sans”" (the saved font's old position).
      await ui.click();
      await expect(uiOptions).toBeVisible();
      await ui.press('Escape');
      await expect(ui, 'input state: the list is closed').toHaveAttribute('aria-expanded', 'false');
      await expect(ui).toBeFocused();
      await ui.fill('sans');
      await expect(uiOptions).toBeVisible();
      const alphaId = await uiOptions.getByRole('option', { name: 'Alpha Sans', exact: true }).getAttribute('id');
      await expect(ui, 'typing highlights the first matching family').toHaveAttribute('aria-activedescendant', alphaId ?? '');
      await ui.press('Enter');
      await expect.poll(() => setting(win, 'ui_font_family')).toBe('Alpha Sans');
      await expect(ui).toHaveValue('Alpha Sans');

      // With System default saved, a name no family matches is saved exactly (trimmed).
      // A stale highlight would land on System default and save nothing.
      await ui.click();
      await fontReset(win, 'ui_font_family').click();
      await expect.poll(() => setting(win, 'ui_font_family')).toBeNull();
      // The field is disabled while saving, which drops focus; refocus and close the list.
      await ui.click();
      await expect(uiOptions).toBeVisible();
      await ui.press('Escape');
      await expect(ui, 'input state: the list is closed').toHaveAttribute('aria-expanded', 'false');
      await expect(ui).toBeFocused();
      await ui.fill('  Brand New Ω  ');
      const custom = uiOptions.getByRole('option', { name: 'Use “Brand New Ω”', exact: true });
      await expect(custom).toBeVisible();
      await expect(ui, 'typing highlights the custom option').toHaveAttribute('aria-activedescendant', (await custom.getAttribute('id')) ?? '');
      await ui.press('Enter');
      await expect.poll(() => setting(win, 'ui_font_family')).toBe('Brand New Ω');
      expect(await setting(win, 'terminal_font_family'), 'the Interface saves never touched Terminal').toBe('Barrier Terminal');
    } finally {
      await harness.close();
    }
  });

  test('AC7-AC10: legacy stacks are defaults, independent values survive restart, and a failed save keeps the effective value', async () => {
    const fixture = createFixture();
    let harness = await launchHarness(fixture);
    try {
      await openProject(harness.win);
      const defaultUiDeclaration = await harness.win.evaluate((property) => {
        for (const sheet of document.styleSheets) {
          for (const rule of sheet.cssRules) {
            if (
              rule instanceof CSSStyleRule
              && rule.selectorText === 'html, body'
              && rule.style.fontFamily.includes(property)
            ) return rule.style.fontFamily;
          }
        }
        return '';
      }, UI_FONT_CSS_PROPERTY);
      expect(defaultUiDeclaration).toBe(`var(${UI_FONT_CSS_PROPERTY}, ${UI_FONT_FALLBACK})`);
      expect(await harness.win.locator('html').evaluate(
        (element, property) => element.style.getPropertyValue(property),
        UI_FONT_CSS_PROPERTY,
      )).toBe('');
      expect(await harness.win.locator('body').evaluate(
        (element) => getComputedStyle(element).fontFamily.length,
      )).toBeGreaterThan(0);
      await expect.poll(async () => (await terminalProbes(harness.win))[0]?.fontFamily).toBe(TERMINAL_FONT_FALLBACK);
      expect(await setting(harness.win, 'ui_font_family')).toBeNull();
      expect(await setting(harness.win, 'terminal_font_family')).toBeNull();

      await openSettings(harness.win);
      await setFontThroughUi(harness.win, 'ui_font_family', 'Persisted UI Ω');
      await setFontThroughUi(harness.win, 'terminal_font_family', 'Persisted Terminal Ω');
      await harness.win.getByTestId('settings-done').click();
      await harness.close(false);

      harness = await launchHarness(fixture, { addRoot: false });
      await expect.poll(() => setting(harness.win, 'ui_font_family')).toBe('Persisted UI Ω');
      await expect.poll(() => setting(harness.win, 'terminal_font_family')).toBe('Persisted Terminal Ω');
      expect(await harness.win.locator('html').evaluate((element, property) => element.style.getPropertyValue(property), UI_FONT_CSS_PROPERTY)).toContain('Persisted UI Ω');
      await openProject(harness.win);
      await expect.poll(async () => (await terminalProbes(harness.win))[0]?.fontFamily).toContain('Persisted Terminal Ω');

      const effectiveBefore = await harness.win.locator('html').evaluate((element, property) => element.style.getPropertyValue(property), UI_FONT_CSS_PROPERTY);
      await harness.app.evaluate(({ ipcMain }) => {
        const ipcMainWithHandlers = ipcMain as unknown as IpcMainWithHandlers;
        const original = ipcMainWithHandlers._invokeHandlers?.get('settings:set-font');
        if (!original) throw new Error('settings:set-font handler unavailable');
        let failOnce = true;
        ipcMain.removeHandler('settings:set-font');
        ipcMain.handle('settings:set-font', (event, request: { key?: string }) => {
          if (failOnce && request.key === 'ui_font_family') {
            failOnce = false;
            throw new Error('injected durable save failure');
          }
          return original(event, request);
        });
      });
      await openSettings(harness.win);
      const ui = fontInput(harness.win, 'ui_font_family');
      await ui.fill('Must Not Apply');
      await ui.press('Enter');
      await expect(harness.win.getByTestId('settings-modal').getByRole('alert')).toContainText(/save|failure|failed/i);
      expect(await setting(harness.win, 'ui_font_family')).toBe('Persisted UI Ω');
      expect(await harness.win.locator('html').evaluate((element, property) => element.style.getPropertyValue(property), UI_FONT_CSS_PROPERTY)).toBe(effectiveBefore);
    } finally {
      await harness.close();
    }
  });

  test('AC11-AC14: UI family propagates live while editor, code, and path surfaces remain monospaced and stable', async () => {
    const harness = await launchHarness();
    try {
      const { app, win } = harness;
      await openProject(win);
      const [popout] = await Promise.all([
        app.waitForEvent('window'),
        win.getByTestId('popout-shell').click(),
      ]);
      await popout.waitForLoadState('domcontentloaded');
      await expect(popout.locator('.xterm')).toBeVisible({ timeout: E2E_TIMEOUT });
      const popoutTerminalFamily = (await terminalProbes(popout))[0]?.fontFamily;
      if (!popoutTerminalFamily) throw new Error('popout terminal probe unavailable');

      await win.getByRole('button', { name: 'Files', exact: true }).click();
      await win.getByTestId('file-entry').filter({ hasText: 'sample.ts' }).click();
      const readOnlySourceFont = await win.getByTestId('file-preview').locator('pre.font-mono')
        .evaluate((element) => getComputedStyle(element).fontFamily);
      await win.getByTestId('file-edit-toggle').click();
      const editor = win.getByTestId('file-editor');
      const textarea = editor.locator('textarea');
      await expect(textarea).toBeVisible();
      const unsaved = `${await textarea.inputValue()}\nconst UNSAVED_FONT_MARKER = true;`;
      await textarea.fill(unsaved);
      await textarea.evaluate((element) => {
        const input = element as HTMLTextAreaElement;
        input.scrollTop = 500;
        input.scrollLeft = 20;
        input.setSelectionRange(45, 73, 'forward');
        input.focus();
      });
      const before = await textarea.evaluate((element) => {
        const input = element as HTMLTextAreaElement;
        return {
          value: input.value,
          start: input.selectionStart,
          end: input.selectionEnd,
          direction: input.selectionDirection,
          scrollTop: input.scrollTop,
          scrollLeft: input.scrollLeft,
          font: getComputedStyle(input).fontFamily,
        };
      });
      const monoBefore = await Promise.all([
        editor.locator('pre').evaluate((element) => getComputedStyle(element).fontFamily),
        editor.locator('[aria-hidden]').first().evaluate((element) => getComputedStyle(element).fontFamily),
        win.getByTestId('file-preview').locator('.font-mono').first().evaluate((element) => getComputedStyle(element).fontFamily),
      ]);
      const ordinaryBefore = await win.locator('body').evaluate((element) => getComputedStyle(element).fontFamily);

      await openSettings(win);
      await setFontThroughUi(win, 'ui_font_family', 'Live UI Family Ω');
      const ordinaryAfter = await win.locator('body').evaluate((element) => getComputedStyle(element).fontFamily);
      expect(ordinaryAfter).not.toBe(ordinaryBefore);
      expect(ordinaryAfter).toContain('Live UI Family Ω');
      await expect.poll(() => popout.locator('body').evaluate((element) => getComputedStyle(element).fontFamily)).toContain('Live UI Family Ω');
      await expect(popout.getByText(PROJECT, { exact: true })).toBeVisible();
      expect((await terminalProbes(popout))[0]?.fontFamily).toBe(popoutTerminalFamily);

      const after = await textarea.evaluate((element) => {
        const input = element as HTMLTextAreaElement;
        return {
          value: input.value,
          start: input.selectionStart,
          end: input.selectionEnd,
          direction: input.selectionDirection,
          scrollTop: input.scrollTop,
          scrollLeft: input.scrollLeft,
          font: getComputedStyle(input).fontFamily,
        };
      });
      expect(after).toEqual(before);
      expect(await Promise.all([
        editor.locator('pre').evaluate((element) => getComputedStyle(element).fontFamily),
        editor.locator('[aria-hidden]').first().evaluate((element) => getComputedStyle(element).fontFamily),
        win.getByTestId('file-preview').locator('.font-mono').first().evaluate((element) => getComputedStyle(element).fontFamily),
      ])).toEqual(monoBefore);
      await expect(fontInput(win, 'ui_font_family')).toBeEnabled();
      await win.getByTestId('settings-done').click();
      await win.getByTestId('file-edit-toggle').click();
      const sourcePreviewFont = await win.getByTestId('file-preview').locator('pre.font-mono')
        .evaluate((element) => getComputedStyle(element).fontFamily);
      expect(sourcePreviewFont).toBe(readOnlySourceFont);
      expect(sourcePreviewFont).not.toContain('Live UI Family Ω');

      await win.getByTestId('file-entry').filter({ hasText: 'guide.md' }).click();
      const markdown = win.getByTestId('markdown-preview');
      await expect(markdown).toBeVisible();
      const proseFont = await markdown.locator('p').first().evaluate((element) => getComputedStyle(element).fontFamily);
      const inlineCodeFont = await markdown.locator('p code').evaluate((element) => getComputedStyle(element).fontFamily);
      const blockFont = await markdown.locator('pre').evaluate((element) => getComputedStyle(element).fontFamily);
      expect(proseFont).toContain('Live UI Family Ω');
      expect(inlineCodeFont).not.toContain('Live UI Family Ω');
      expect(blockFont).not.toContain('Live UI Family Ω');
      expect(inlineCodeFont).toContain('monospace');
      expect(blockFont).toContain('monospace');
    } finally {
      await harness.close();
    }
  });

  test('AC15-AC17, AC19-AC20: all open xterms update in place, preserve state, and report post-change geometry', async () => {
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
        const project = projects.find((candidate) => candidate.name === projectName);
        if (!project) throw new Error('font E2E project unavailable');
        const { shellIndex } = await rendererWindow.api.invoke('shells:launch-plain', {
          projectId: project.id,
        }) as { shellIndex: number };
        return { projectId: project.id, shellIndex };
      }, PROJECT);
      const poppedIndex = poppedShell.shellIndex;
      const [popout] = await Promise.all([
        app.waitForEvent('window'),
        win.evaluate(async (request) => {
          const rendererWindow = window as unknown as RendererWindow;
          await rendererWindow.api.invoke('windows:popout-shell', request);
        }, poppedShell),
      ]);
      await popout.waitForLoadState('domcontentloaded');
      await expect(popout.locator('.xterm')).toBeVisible({ timeout: E2E_TIMEOUT });
      await expect(win.locator('.split-left .xterm')).toBeVisible({ timeout: E2E_TIMEOUT });
      await expect(win.getByTestId('split-right').locator('.xterm')).toBeVisible({ timeout: E2E_TIMEOUT });

      const marker = `font-input-${Date.now()}`;
      await win.locator('.split-left .xterm').click();
      await win.keyboard.type(marker);
      await expect.poll(() => shellOutput(win), { timeout: E2E_TIMEOUT }).toContain(marker);
      await selectEveryTerminal(win);
      await selectEveryTerminal(popout);
      const mainBefore = await terminalProbes(win);
      const popoutBefore = await terminalProbes(popout);
      expect(mainBefore).toHaveLength(2);
      expect(popoutBefore).toHaveLength(1);
      expect(mainBefore.every((probe) => probe.selection.length > 0)).toBe(true);
      expect(popoutBefore[0]?.selection.length).toBeGreaterThan(0);
      expect(mainBefore.every((probe) => probe.unicodeVersion === '11')).toBe(true);
      await installResizeRecorder(app);

      await openSettings(win);
      await setFontThroughUi(win, 'terminal_font_family', 'Live Terminal Family Ω');
      await expect.poll(async () => (await terminalProbes(win)).map((probe) => probe.fontFamily)).toEqual([
        expect.stringContaining('Live Terminal Family Ω'),
        expect.stringContaining('Live Terminal Family Ω'),
      ]);
      await expect.poll(async () => (await terminalProbes(popout))[0]?.fontFamily).toContain('Live Terminal Family Ω');

      const mainAfter = await terminalProbes(win);
      const popoutAfter = await terminalProbes(popout);
      const popoutBeforeProbe = popoutBefore[0];
      const popoutAfterProbe = popoutAfter[0];
      if (!popoutBeforeProbe || !popoutAfterProbe) throw new Error('popout terminal probe disappeared');
      expect(mainAfter.map((probe) => probe.token)).toEqual(mainBefore.map((probe) => probe.token));
      expect(popoutAfter.map((probe) => probe.token)).toEqual(popoutBefore.map((probe) => probe.token));
      expect(mainAfter.map((probe) => probe.selection)).toEqual(mainBefore.map((probe) => probe.selection));
      expect(popoutAfterProbe.selection).toBe(popoutBeforeProbe.selection);
      expect(mainAfter.every((probe, index) => {
        const prior = mainBefore[index];
        return prior !== undefined && probe.bufferLength >= prior.bufferLength;
      })).toBe(true);
      expect(popoutAfterProbe.bufferLength).toBeGreaterThanOrEqual(popoutBeforeProbe.bufferLength);
      const leftScreen = mainAfter.find((probe) => probe.key === 'left')?.screen ?? '';
      expect(leftScreen.replace(/\s+/gu, '')).toContain(marker);

      await expect.poll(() => resizeCalls(app), { timeout: E2E_TIMEOUT }).toHaveLength(3);
      const latest = latestCallsByShell(await resizeCalls(app));
      expect(latest.size).toBe(3);
      const rightIndex = [...latest.keys()].find((index) => index !== 0 && index !== poppedIndex);
      const leftProbe = mainAfter.find((probe) => probe.key === 'left');
      const rightProbe = mainAfter.find((probe) => probe.key === 'right');
      if (rightIndex === undefined || !leftProbe || !rightProbe) throw new Error('terminal geometry probe incomplete');
      expect(latest.get(0)).toMatchObject({ cols: leftProbe.cols, rows: leftProbe.rows });
      expect(latest.get(rightIndex)).toMatchObject({ cols: rightProbe.cols, rows: rightProbe.rows });
      expect(latest.get(poppedIndex)).toMatchObject({ cols: popoutAfterProbe.cols, rows: popoutAfterProbe.rows });

      await win.getByTestId('settings-done').click();
      await win.locator('.split-left .xterm').click();
      await win.keyboard.press('Enter');
      await expect.poll(() => shellOutput(win), { timeout: E2E_TIMEOUT }).toContain(`echo: ${marker}`);

      // Existing zoom stays live, refits, and does not recreate the Terminal.
      await win.locator('.split-left .xterm').click();
      const beforeZoom = (await terminalProbes(win)).find((probe) => probe.key === 'left')!;
      await win.keyboard.press('Meta+=');
      await expect.poll(async () => (await terminalProbes(win)).find((probe) => probe.key === 'left')?.fontSize).toBe(beforeZoom.fontSize + 1);
      const afterZoom = (await terminalProbes(win)).find((probe) => probe.key === 'left')!;
      expect(afterZoom.token).toBe(beforeZoom.token);
      await expect.poll(async () => latestCallsByShell(await resizeCalls(app)).get(0)).toMatchObject({ cols: afterZoom.cols, rows: afterZoom.rows });
    } finally {
      await harness.close();
    }
  });

  test('AC17, AC19: rejected and timed-out font readiness remain usable, and copy sanitation is unchanged', async () => {
    const harness = await launchHarness();
    try {
      const { win } = harness;
      await openProject(win);
      const initial = (await terminalProbes(win))[0];
      if (!initial) throw new Error('initial terminal probe unavailable');

      await overrideFontReadiness(win, 'reject');
      await openSettings(win);
      await setFontThroughUi(win, 'terminal_font_family', 'Readiness Reject Family');
      await expect.poll(async () => (await terminalProbes(win))[0]?.fontFamily, { timeout: E2E_TIMEOUT }).toContain('Readiness Reject Family');
      const afterReject = (await terminalProbes(win))[0];
      if (!afterReject) throw new Error('terminal disappeared after rejected readiness');
      expect(afterReject.token).toBe(initial.token);

      await overrideFontReadiness(win, 'timeout');
      await setFontThroughUi(win, 'terminal_font_family', 'Readiness Timeout Family');
      await expect.poll(async () => (await terminalProbes(win))[0]?.fontFamily, { timeout: E2E_TIMEOUT }).toContain('Readiness Timeout Family');
      await win.getByTestId('settings-done').click();
      const usableMarker = `usable-${Date.now()}`;
      await win.locator('.xterm').click();
      await win.keyboard.type(usableMarker);
      await win.keyboard.press('Enter');
      await expect.poll(() => shellOutput(win), { timeout: E2E_TIMEOUT }).toContain(`echo: ${usableMarker}`);

      const copy = await exerciseCopySanitizer(win);
      expect(copy.selected).toContain('COPY-A');
      expect(copy.selected).toContain('\uE0B0');
      expect(copy.selected).toContain('COPY-B');
      expect(copy.copied).toContain('COPY-A');
      expect(copy.copied).toContain('COPY-B');
      expect(copy.copied).not.toContain('\uE0B0');
    } finally {
      await overrideFontReadiness(harness.win, 'restore').catch(() => {});
      await harness.close();
    }
  });
});
