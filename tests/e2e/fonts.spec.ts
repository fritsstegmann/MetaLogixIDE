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

async function mockLocalFonts(
  win: Page,
  behavior: { kind: 'success'; families: string[] } | { kind: 'denied' } | { kind: 'unsupported' },
): Promise<void> {
  await win.evaluate((mock) => {
    if (mock.kind === 'unsupported') {
      Object.defineProperty(window, 'queryLocalFonts', { configurable: true, value: undefined });
      return;
    }
    const query = mock.kind === 'denied'
      ? async (): Promise<never> => { throw new DOMException('Font access denied by test', 'NotAllowedError'); }
      : async (): Promise<Array<{ family: string }>> => mock.families.map((family) => ({ family }));
    Object.defineProperty(window, 'queryLocalFonts', { configurable: true, value: query });
  }, behavior);
}

function installedFamilies(win: Page, key: FontSettingKey): Locator {
  const label = key === 'ui_font_family' ? FONT_COPY.uiLabel : FONT_COPY.terminalLabel;
  return win.getByRole('list', { name: `Installed fonts for ${label.toLowerCase()}`, exact: true });
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
  test('AC1-AC7, AC9-AC10: independent accessible controls support manual keyboard entry, validation, reset, and safe literal names', async () => {
    const harness = await launchHarness();
    try {
      const { win } = harness;
      await openSettings(win);
      const modal = win.getByTestId('settings-modal');
      const ui = win.getByLabel(FONT_COPY.uiLabel, { exact: true });
      const terminal = win.getByLabel(FONT_COPY.terminalLabel, { exact: true });

      await expect(ui).toHaveCount(1);
      await expect(terminal).toHaveCount(1);
      await expect(fontInput(win, 'ui_font_family')).toHaveValue('');
      await expect(fontInput(win, 'terminal_font_family')).toHaveValue('');

      await ui.focus();
      await expect(ui).toBeFocused();

      await ui.fill('  Trimmed Ω Family  ');
      await ui.press('Enter');
      await expect.poll(() => setting(win, 'ui_font_family')).toBe('Trimmed Ω Family');
      await expect(ui).toHaveValue('Trimmed Ω Family');

      for (const invalid of ['   ', 'bad\u0000family', '😀'.repeat(257)]) {
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

      await setFontThroughUi(win, 'terminal_font_family', 'Independent Terminal');
      await fontReset(win, 'ui_font_family').focus();
      await win.keyboard.press('Enter');
      await expect.poll(() => setting(win, 'ui_font_family')).toBeNull();
      expect(await setting(win, 'terminal_font_family')).toBe('Independent Terminal');

      await expect(ui).toHaveValue('');
      await expect(terminal).toHaveValue('Independent Terminal');
    } finally {
      await harness.close();
    }
  });

  test('installed font pickers filter, preview, and independently persist keyboard selections without closing Settings', async () => {
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

      const choose = modal.getByRole('button', { name: 'Choose installed font', exact: true });
      await choose.first().focus();
      await win.keyboard.press('Enter');
      const uiSearch = modal.getByRole('searchbox', {
        name: `Search installed fonts for ${FONT_COPY.uiLabel.toLowerCase()}`, exact: true,
      });
      const uiFamilies = installedFamilies(win, 'ui_font_family');
      await expect(uiSearch).toBeVisible();
      await expect(uiFamilies.getByRole('button')).toHaveCount(4);
      for (const family of ['Alpha Font', 'Comma, Family', 'Éclair Mono', 'zeta Mono']) {
        const row = uiFamilies.getByRole('button', { name: new RegExp(`^${family} `) });
        await expect(row).toBeVisible();
        await expect(row.getByText('Aa Bb 0O 1l — The quick brown fox', { exact: true }))
          .toHaveCSS('font-family', new RegExp(family));
      }
      await expect(fontStatus(win, 'ui_font_family')).toContainText(FONT_COPY.unavailable);
      await expect(fontStatus(win, 'terminal_font_family')).toContainText(FONT_COPY.unavailable);
      const unavailablePreviewStack = await modal.getByLabel(`${FONT_COPY.terminalLabel} preview`)
        .evaluate((element) => getComputedStyle(element).fontFamily);
      expect(unavailablePreviewStack).toContain('Missing Font Family');
      expect(unavailablePreviewStack).toContain(TERMINAL_FONT_FALLBACK);

      await uiSearch.fill('  ÉCL  ');
      await expect(uiFamilies.getByRole('button')).toHaveCount(1);
      await expect(uiFamilies.getByRole('button', { name: /^Éclair Mono / })).toBeVisible();
      await expect(uiFamilies.getByRole('button', { name: /^Alpha Font / })).toHaveCount(0);
      await uiSearch.fill('No such installed family');
      await expect(uiFamilies.getByRole('button')).toHaveCount(0);
      await expect(modal.getByText('No installed fonts match your search.', { exact: true })).toBeVisible();
      expect(await setting(win, 'ui_font_family')).toBe('Missing UI Family');
      await uiSearch.fill('écl');
      await expect(modal.getByText('No installed fonts match your search.', { exact: true })).toHaveCount(0);
      await uiSearch.focus();
      await win.keyboard.press('Tab');
      await expect(uiFamilies.getByRole('button', { name: /^Éclair Mono / })).toBeFocused();
      await win.keyboard.press('Enter');
      await expect.poll(() => setting(win, 'ui_font_family')).toBe('Éclair Mono');
      await expect(fontInput(win, 'ui_font_family')).toHaveValue('Éclair Mono');
      await expect(fontStatus(win, 'ui_font_family')).toHaveText('Font is installed on this computer.');
      expect(await setting(win, 'terminal_font_family')).toBe('Missing Font Family');

      await choose.click();
      const terminalSearch = modal.getByRole('searchbox', {
        name: `Search installed fonts for ${FONT_COPY.terminalLabel.toLowerCase()}`, exact: true,
      });
      const terminalFamilies = installedFamilies(win, 'terminal_font_family');
      await terminalSearch.fill('ZETA');
      await expect(terminalFamilies.getByRole('button')).toHaveCount(1);
      await expect(uiSearch).toHaveValue('écl');
      await terminalSearch.focus();
      await win.keyboard.press('Tab');
      await expect(terminalFamilies.getByRole('button', { name: /^zeta Mono / })).toBeFocused();
      await win.keyboard.press('Space');
      await expect.poll(() => setting(win, 'terminal_font_family')).toBe('zeta Mono');
      await expect(fontInput(win, 'terminal_font_family')).toHaveValue('zeta Mono');
      await expect(fontStatus(win, 'terminal_font_family')).toHaveText('Font is installed on this computer.');
      expect(await setting(win, 'ui_font_family')).toBe('Éclair Mono');

      await terminalSearch.focus();
      await win.keyboard.press('Escape');
      await expect(terminalSearch).toHaveCount(0);
      await expect(terminalFamilies).toHaveCount(0);
      await expect(fontInput(win, 'terminal_font_family')).toBeFocused();
      await expect(uiSearch).toBeVisible();
      await expect(modal).toBeVisible();
      await uiSearch.focus();
      await win.keyboard.press('Escape');
      await expect(uiSearch).toHaveCount(0);
      await expect(fontInput(win, 'ui_font_family')).toBeFocused();
      await expect(modal).toBeVisible();
      await expect(choose).toHaveCount(2);
      expect(await setting(win, 'ui_font_family')).toBe('Éclair Mono');
      expect(await setting(win, 'terminal_font_family')).toBe('zeta Mono');

      await win.getByTestId('settings-done').click();
      await openSettings(win);
      await expect(fontInput(win, 'ui_font_family')).toHaveValue('Éclair Mono');
      await expect(fontInput(win, 'terminal_font_family')).toHaveValue('zeta Mono');
    } finally {
      await harness.close();
    }
  });

  test('denied font discovery retries successfully without leaving Settings and keeps manual entry and reset usable', async () => {
    const harness = await launchHarness();
    try {
      const { win } = harness;
      await mockLocalFonts(win, { kind: 'denied' });
      await openSettings(win);
      const modal = win.getByTestId('settings-modal');
      await setFontThroughUi(win, 'terminal_font_family', 'Manual While Denied');
      await modal.getByRole('button', { name: 'Choose installed font', exact: true }).last().click();
      await expect(modal.getByRole('status')).toHaveText('Access to installed fonts was denied.');
      await expect(fontStatus(win, 'terminal_font_family')).toContainText(FONT_COPY.unknown);
      await expect(fontStatus(win, 'terminal_font_family')).not.toContainText(FONT_COPY.unavailable);
      await fontReset(win, 'terminal_font_family').focus();
      await win.keyboard.press('Space');
      await expect.poll(() => setting(win, 'terminal_font_family')).toBeNull();
      await setFontThroughUi(win, 'terminal_font_family', 'Retry Mono');

      await mockLocalFonts(win, { kind: 'success', families: ['Retry Mono', 'Another Family'] });
      await modal.getByRole('button', { name: 'Retry loading installed fonts', exact: true }).last().click();
      await expect(installedFamilies(win, 'terminal_font_family').getByRole('button')).toHaveCount(2);
      await expect(fontStatus(win, 'terminal_font_family')).toHaveText('Font is installed on this computer.');
      await expect(modal.getByRole('status')).toHaveCount(0);
      await expect(modal).toBeVisible();
      await expect(fontInput(win, 'terminal_font_family')).toHaveValue('Retry Mono');

      await win.getByTestId('settings-done').click();
      await mockLocalFonts(win, { kind: 'unsupported' });
      await openSettings(win);
      await setFontThroughUi(win, 'ui_font_family', 'Manual Unsupported');
      await modal.getByRole('button', { name: 'Choose installed font', exact: true }).first().click();
      await expect(modal.getByRole('status')).toHaveText('Installed font discovery is not supported.');
      await expect(fontStatus(win, 'ui_font_family')).toContainText(FONT_COPY.unknown);
      await expect(fontReset(win, 'ui_font_family')).toBeEnabled();
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
      await expect(fontReset(win, 'ui_font_family')).toBeEnabled();
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
