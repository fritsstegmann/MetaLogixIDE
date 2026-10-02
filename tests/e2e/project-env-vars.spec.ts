import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENV_COPY, ENV_TESTIDS } from '../../src/renderer/project-env-copy';
import { launch, openProject, projectId, sendLine, type Api, type Harness } from './helpers/claude-harness';

/**
 * Per-project environment variables (docs/specs/project-env-vars.md).
 *
 * Why this home can observe the behaviour: this suite drives the built
 * Electron app — real main process, real `PtyManager` spawning a real login
 * shell, real SQLite under an isolated HOME. Nothing is stubbed, so whatever
 * the shell prints is the environment `node-pty` actually handed the child.
 * `launch()` gives an isolated HOME with no rc files and SHELL=/bin/sh, so the
 * login shell has no profile that could overwrite the variables under test.
 * (macOS /etc/profile still runs `path_helper`, which reorders PATH entries
 * but keeps their relative order — PATH assertions below check relative order,
 * not a literal prefix.)
 *
 * Terminal output is read from `shells:snapshot` (xterm renders via WebGL, so
 * there is no DOM text). Every printf format below carries a marker like
 * `ENV1[` followed by `%s`, and every regex asserts the *expanded* output, so
 * the shell's echo of the typed command can never satisfy an assertion.
 */

const PROJECT_A = 'envproja';
const PROJECT_B = 'envprojb';
const VAR_URL = 'E2E_API_URL';

let h: Harness | undefined;

test.afterEach(async () => {
  await h?.app.close();
  h?.cleanup();
  h = undefined;
});

/** Plain shell for a project; returns its shellIndex. */
async function launchPlain(win: Page, projId: number): Promise<number> {
  return win.evaluate(async (id: number) => {
    const api = (window as unknown as { api: Api }).api;
    return (await api.invoke('shells:launch-plain', { projectId: id }) as unknown as { shellIndex: number }).shellIndex;
  }, projId);
}

async function snapshot(win: Page, projId: number, shellIndex: number): Promise<string> {
  return win.evaluate(async (args: { projectId: number; shellIndex: number }) => {
    const api = (window as unknown as { api: Api }).api;
    return (await api.invoke('shells:snapshot', args) as unknown as { output: string }).output;
  }, { projectId: projId, shellIndex });
}

/** The project's persisted `config.env`, read from `projects:list` (what storage holds, not what the dialog shows). */
async function storedEnv(win: Page, name: string): Promise<Record<string, string> | undefined> {
  return win.evaluate(async (n: string) => {
    const api = (window as unknown as { api: Api }).api;
    const { projects } = (await api.invoke('projects:list', undefined)) as unknown as {
      projects: Array<{ name: string; config: { env?: Record<string, string> } }>;
    };
    const p = projects.find((x) => x.name === n);
    if (!p) throw new Error(`project not found: ${n}`);
    return p.config.env;
  }, name);
}

function dialogOf(win: Page): Locator {
  return win.getByRole('dialog', { name: ENV_COPY.dialogTitle });
}

async function openEditorFromHeader(win: Page): Promise<Locator> {
  await win.getByTestId(ENV_TESTIDS.headerButton).click();
  const dialog = dialogOf(win);
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Appends a row and fills it; `n` is the 1-based row number the new row gets. */
async function addRow(dialog: Locator, n: number, name: string, value: string): Promise<void> {
  await dialog.getByTestId(ENV_TESTIDS.add).click();
  await dialog.getByLabel(ENV_COPY.nameLabel(n), { exact: true }).fill(name);
  await dialog.getByLabel(ENV_COPY.valueLabel(n), { exact: true }).fill(value);
}

async function save(dialog: Locator): Promise<void> {
  await dialog.getByTestId(ENV_TESTIDS.save).click();
  await expect(dialog).toBeHidden();
}

function reason(dialog: Locator, text: string): Locator {
  return dialog.getByTestId(ENV_TESTIDS.reason).filter({ hasText: text }).first();
}

test('editor journey: empty state, notices, save, reopen, plain shell sees interpolated vars (AC1-AC4, AC6, AC10, AC12)', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  // A directory that exists only in the *inherited* PATH: if `${env.PATH}`
  // resolved to '' (or the project var replaced PATH wholesale), it vanishes.
  const inheritedMarker = mkdtempSync(join(tmpdir(), 'metaide-e2e-inheritedbin-'));
  const origPath = process.env.PATH;
  process.env.PATH = `${inheritedMarker}:${origPath ?? ''}`;
  try {
    h = await launch([PROJECT_A, PROJECT_B]);
  } finally {
    process.env.PATH = origPath;
  }
  const { win } = h;
  await openProject(win, PROJECT_A);
  const idA = await projectId(win, PROJECT_A);

  // AC1 (header entry), AC2 (empty state), AC6 (notices visible without hover).
  const dialog = await openEditorFromHeader(win);
  await expect(dialog.getByTestId(ENV_TESTIDS.empty)).toHaveText(ENV_COPY.emptyState);
  await expect(dialog.getByTestId(ENV_TESTIDS.row)).toHaveCount(0);
  await expect(dialog.getByText(ENV_COPY.noticeNewShells)).toBeVisible();
  await expect(dialog.getByText(ENV_COPY.noticeUnencrypted)).toBeVisible();
  await expect(dialog.getByText(ENV_COPY.tokensHint)).toBeVisible();

  await addRow(dialog, 1, VAR_URL, 'http://localhost:4000');
  await addRow(dialog, 2, 'PATH', '${PROJECT_PATH}/bin:${env.PATH}');
  await addRow(dialog, 3, 'E2E_GREETING', 'hi-${PROJECT_NAME}');
  // Positive control for the empty state: it goes away once a row exists.
  await expect(dialog.getByTestId(ENV_TESTIDS.empty)).toHaveCount(0);
  await expect(dialog.getByTestId(ENV_TESTIDS.save)).toBeEnabled();
  await save(dialog);

  // AC4: storage holds exactly the rows saved, in saved order, token text raw.
  const stored = await storedEnv(win, PROJECT_A);
  expect(Object.keys(stored ?? {})).toEqual([VAR_URL, 'PATH', 'E2E_GREETING']);
  expect(stored).toEqual({
    [VAR_URL]: 'http://localhost:4000',
    PATH: '${PROJECT_PATH}/bin:${env.PATH}',
    E2E_GREETING: 'hi-${PROJECT_NAME}',
  });

  // AC2/AC4: reopening shows the saved rows in order.
  const reopened = await openEditorFromHeader(win);
  await expect(reopened.getByTestId(ENV_TESTIDS.empty)).toHaveCount(0);
  const names = reopened.getByTestId(ENV_TESTIDS.name);
  const values = reopened.getByTestId(ENV_TESTIDS.value);
  await expect(names).toHaveCount(3);
  await expect(names.nth(0)).toHaveValue(VAR_URL);
  await expect(names.nth(1)).toHaveValue('PATH');
  await expect(names.nth(2)).toHaveValue('E2E_GREETING');
  await expect(values.nth(0)).toHaveValue('http://localhost:4000');
  await expect(values.nth(1)).toHaveValue('${PROJECT_PATH}/bin:${env.PATH}');
  await reopened.getByTestId(ENV_TESTIDS.cancel).click();
  await expect(reopened).toBeHidden();

  // AC10 (plain shell site), AC12: values interpolated at spawn.
  const idx = await launchPlain(win, idA);
  await sendLine(win, idA, idx,
    `printf 'ENV1[%s]\\n' "$${VAR_URL}"; printf 'GREET[%s]\\n' "$E2E_GREETING"; ` +
    `pidx() { echo "$PATH" | tr ':' '\\n' | grep -n -F -e "$1" | cut -d: -f1 | head -1; }; ` +
    `printf 'PATHIDX[%s,%s]\\n' "$(pidx /${PROJECT_A}/bin)" "$(pidx ${inheritedMarker})"`);
  await expect.poll(() => snapshot(win, idA, idx), { timeout: 15000 }).toMatch(/PATHIDX\[\d+,\d+\]/);
  const out = await snapshot(win, idA, idx);
  expect(out).toContain('ENV1[http://localhost:4000]');
  expect(out).toContain('GREET[hi-envproja]');
  // `${PROJECT_PATH}/bin` entry exists and comes before the inherited marker
  // entry (extends, not replaces: the marker only reaches the shell via ${env.PATH}).
  const m = /PATHIDX\[(\d+),(\d+)\]/.exec(out);
  expect(m).not.toBeNull();
  expect(Number(m![1])).toBeLessThan(Number(m![2]));
});

test('validation: invalid / reserved / duplicate names disable Save with a reason; Escape, Cancel and Close discard (AC3, AC5)', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  h = await launch([PROJECT_A, PROJECT_B]);
  const { win } = h;
  await openProject(win, PROJECT_A);

  const dialog = await openEditorFromHeader(win);
  const saveBtn = dialog.getByTestId(ENV_TESTIDS.save);
  await addRow(dialog, 1, 'MY-VAR', 'x');
  await expect(reason(dialog, ENV_COPY.reason.invalid)).toBeVisible();
  await expect(saveBtn).toBeDisabled();

  const name1 = dialog.getByLabel(ENV_COPY.nameLabel(1), { exact: true });
  await name1.fill('1FOO');
  await expect(reason(dialog, ENV_COPY.reason.invalid)).toBeVisible();
  await expect(saveBtn).toBeDisabled();

  await name1.fill('METAIDE_HOOK_TOKEN');
  await expect(reason(dialog, ENV_COPY.reason.reserved)).toBeVisible();
  await expect(saveBtn).toBeDisabled();

  // Duplicate (case-sensitive): two GOOD rows.
  await name1.fill('GOOD');
  await expect(dialog.getByTestId(ENV_TESTIDS.reason)).toHaveCount(0);
  await expect(saveBtn).toBeEnabled();
  await addRow(dialog, 2, 'GOOD', 'y');
  await expect(reason(dialog, ENV_COPY.reason.duplicate)).toBeVisible();
  await expect(saveBtn).toBeDisabled();

  // Positive control: fixing the name clears the reasons and re-enables Save,
  // so the disabled state above was caused by the rows, not a stuck button.
  await dialog.getByLabel(ENV_COPY.nameLabel(2), { exact: true }).fill('GOOD2');
  await expect(dialog.getByTestId(ENV_TESTIDS.reason)).toHaveCount(0);
  await expect(saveBtn).toBeEnabled();

  // AC3: unsaved valid edits are discarded by Escape, Cancel and Close alike.
  await win.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(Object.keys((await storedEnv(win, PROJECT_A)) ?? {})).toEqual([]);

  for (const dismiss of ['cancel', 'close'] as const) {
    const d = await openEditorFromHeader(win);
    // Positive control per pass: the previous pass's rows did not come back.
    await expect(d.getByTestId(ENV_TESTIDS.empty)).toBeVisible();
    await addRow(d, 1, 'DISCARD_ME', 'v');
    await expect(d.getByTestId(ENV_TESTIDS.name)).toHaveCount(1);
    if (dismiss === 'cancel') await d.getByTestId(ENV_TESTIDS.cancel).click();
    else await d.getByRole('button', { name: ENV_COPY.close, exact: true }).click();
    await expect(d).toBeHidden();
    expect(Object.keys((await storedEnv(win, PROJECT_A)) ?? {})).toEqual([]);
  }
  const final = await openEditorFromHeader(win);
  await expect(final.getByTestId(ENV_TESTIDS.empty)).toBeVisible();
  await expect(final.getByTestId(ENV_TESTIDS.row)).toHaveCount(0);
});

test('running shells keep old values; new shells get new; other projects stay empty (AC15, AC16)', async ({}, testInfo) => {
  testInfo.setTimeout(90_000);
  h = await launch([PROJECT_A, PROJECT_B]);
  const { win } = h;
  await openProject(win, PROJECT_A);
  const idA = await projectId(win, PROJECT_A);
  const idB = await projectId(win, PROJECT_B);

  const dialog = await openEditorFromHeader(win);
  await addRow(dialog, 1, VAR_URL, 'old-value');
  await save(dialog);

  const shellOld = await launchPlain(win, idA);
  await sendLine(win, idA, shellOld, `printf 'ENV1[%s]\\n' "$${VAR_URL}"`);
  await expect.poll(() => snapshot(win, idA, shellOld), { timeout: 15000 }).toContain('ENV1[old-value]');

  // Change the value while shellOld is still running.
  const edit = await openEditorFromHeader(win);
  await edit.getByLabel(ENV_COPY.valueLabel(1), { exact: true }).fill('new-value');
  await save(edit);
  expect((await storedEnv(win, PROJECT_A))?.[VAR_URL]).toBe('new-value');

  // AC15: the running shell still has the old value. The ENV2 marker printing
  // is the positive control for the absence of the new value.
  await sendLine(win, idA, shellOld, `printf 'ENV2[%s]\\n' "$${VAR_URL}"`);
  await expect.poll(() => snapshot(win, idA, shellOld), { timeout: 15000 }).toContain('ENV2[old-value]');
  expect(await snapshot(win, idA, shellOld)).not.toContain('ENV2[new-value]');

  // A fresh shell in the same project sees the new value.
  const shellNew = await launchPlain(win, idA);
  await sendLine(win, idA, shellNew, `printf 'ENV2[%s]\\n' "$${VAR_URL}"`);
  await expect.poll(() => snapshot(win, idA, shellNew), { timeout: 15000 }).toContain('ENV2[new-value]');

  // AC16: project B's shell printed the marker (shell works, printf ran) with an empty value.
  const shellB = await launchPlain(win, idB);
  await sendLine(win, idB, shellB, `printf 'ENV2[%s]\\n' "$${VAR_URL}"`);
  await expect.poll(() => snapshot(win, idB, shellB), { timeout: 15000 }).toContain('ENV2[]');
  const outB = await snapshot(win, idB, shellB);
  expect(outB).not.toContain('old-value');
  expect(outB).not.toContain('new-value');
});

test('sidebar context menu opens the editor for that project (AC1)', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  h = await launch([PROJECT_A, PROJECT_B]);
  const { win } = h;
  // A is selected; the menu is opened on B to prove the dialog targets the
  // right-clicked project, not the selected one.
  await openProject(win, PROJECT_A);

  const rowB = win.locator('[data-testid="project-row"]').filter({ has: win.getByText(PROJECT_B, { exact: true }) }).first();
  await expect(rowB).toBeVisible();
  // Right-click near the row's left edge: the menu is a `fixed` child of the
  // sidebar `<aside>`, whose backdrop-filter makes it the containing block and
  // a stacking context, so any part of the menu that spills past the sidebar's
  // right edge is painted under <main> and cannot be clicked (pre-existing,
  // affects every sidebar context-menu item; see report).
  await rowB.click({ button: 'right', position: { x: 8, y: 8 } });
  await win.getByRole('menuitem', { name: ENV_COPY.contextMenuItem, exact: true }).click();

  const dialog = dialogOf(win);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(PROJECT_B);
  await expect(dialog).not.toContainText(PROJECT_A);

  await addRow(dialog, 1, 'E2E_FROM_MENU', '1');
  await save(dialog);
  // Saved onto B; A (positive control: B has it) is untouched.
  expect(await storedEnv(win, PROJECT_B)).toEqual({ E2E_FROM_MENU: '1' });
  expect(Object.keys((await storedEnv(win, PROJECT_A)) ?? {})).toEqual([]);
});
