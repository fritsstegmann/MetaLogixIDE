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
    await expect(
      panel.getByText('Fleet is off. Enable it to discover IDEs on your local network.'),
    ).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Enable fleet' })).toBeVisible();
    const before = await win.evaluate(() => window.api.invoke('fleet:get-state', undefined));
    expect(before.enabled).toBe(false);
    await panel.getByRole('button', { name: 'Enable fleet' }).click();
    await expect(panel.getByRole('button', { name: 'Disable fleet' })).toBeVisible();
    await expect(panel.getByText(/Looking for IDEs on this LAN/)).toBeVisible();
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
    await panel.getByRole('button', { name: 'Disable fleet' }).click();
    await expect(
      panel.getByText('Fleet is off. Enable it to discover IDEs on your local network.'),
    ).toBeVisible();
    await win.getByTestId('ab-projects').click();
    await expect(panel).toBeHidden();
  } finally {
    await closeApp(app);
    cleanup();
  }
});
