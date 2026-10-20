import { expect, test } from '@playwright/test';
import type * as Keytar from 'keytar';
import { closeApp, launch } from './helpers/claude-harness';
import type {} from '../../src/renderer/api';

test('fleet requires local opt-in and rejects unlinked remote shell control', async () => {
  const { app, win, cleanup } = await launch([]);
  try {
    // Load keytar inside Electron, not the test runner, to isolate OS credential prompts in this UI journey.
    await app.evaluate(() => {
      const modules = process.getBuiltinModule('module');
      if (!modules) throw new Error('Node module loader unavailable');
      const keytar: typeof Keytar = modules.createRequire(`${process.cwd()}/package.json`)(
        'keytar',
      );
      const credentials = new Map<string, string>();
      keytar.getPassword = async (service, account) =>
        credentials.get(`${service}:${account}`) ?? null;
      keytar.setPassword = async (service, account, password) => {
        credentials.set(`${service}:${account}`, password);
      };
    });
    await win.getByRole('button', { name: 'Fleet', exact: true }).click();
    const panel = win.getByTestId('fleet-panel');
    await expect(win.locator('main').getByTestId('fleet-panel')).toBeVisible();
    await panel.getByRole('button', { name: 'Open Fleet settings' }).click();
    const settings = win.getByRole('dialog', { name: 'Settings' });
    await expect(settings).toBeVisible();
    await expect(settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Fleet' })).toHaveAttribute('aria-current', 'page');
    const discovery = settings.getByRole('switch', { name: 'Enable Fleet discovery' });
    await expect(discovery).not.toBeChecked();
    const before = await win.evaluate(() => window.api.invoke('fleet:get-state', undefined));
    expect(before.enabled).toBe(false);
    await discovery.click();
    await expect(discovery).toBeChecked();
    await win.getByTestId('settings-done').click();
    await expect.poll(async () => (await win.evaluate(() => window.api.invoke('fleet:get-state', undefined))).enabled).toBe(true);
    const outcome = await win.evaluate(async () => {
      try {
        await window.api.invoke('fleet:write', {
          peerId: 'a'.repeat(64),
          projectId: 1,
          shellIndex: 0,
          data: 'echo never\r',
        });
        return 'accepted';
      } catch {
        return 'rejected';
      }
    });
    expect(outcome).toBe('rejected');
    await win.getByTestId('settings-open').click();
    await expect(discovery).toBeChecked();
    await discovery.click();
    await expect(discovery).not.toBeChecked();
    await win.getByTestId('settings-done').click();
    await win.getByTestId('ab-projects').click();
    await expect(panel).toBeHidden();
  } finally {
    await closeApp(app);
    cleanup();
  }
});

test('Fleet management returns to local project terminal on a narrow window', async () => {
  const { app, win, cleanup } = await launch(['Local Fleet Project']);
  try {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setSize(390, 844);
    });
    await win.getByRole('button', { name: 'Fleet', exact: true }).click();
    await expect(win.getByTestId('fleet-panel')).toBeVisible();
    await win.getByTestId('ab-projects').click();
    const sidebar = win.locator('aside[data-view="projects"]');
    await expect(sidebar).toBeVisible();
    const project = sidebar.getByTestId('project-row').filter({ hasText: 'Local Fleet Project' }).first();
    await expect(project).toBeVisible();
    await project.click();
    await expect(sidebar).toBeHidden();
    await expect(win.locator('main .xterm')).toBeVisible();
    await expect.poll(() => win.title()).toBe('Local Fleet Project — MetaLogix IDE');
    expect(await win.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      await win.evaluate(() => window.innerWidth),
    );
  } finally {
    await closeApp(app);
    cleanup();
  }
});
