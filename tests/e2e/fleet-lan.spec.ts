import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { basename } from 'node:path';
import type * as Keytar from 'keytar';
import { closeApp, launch } from './helpers/claude-harness';
import type {} from '../../src/renderer/api';

test('fleet requires local opt-in and rejects unlinked remote shell control', async () => {
  const { app, win, cleanup } = await launch([]);
  try {
    await isolateFleetCredentials(app);
    await win.getByRole('button', { name: 'Fleet', exact: true }).click();
    const panel = win.getByTestId('fleet-panel');
    await expect(panel).toBeVisible();
    await expect(win.locator('main').getByTestId('fleet-panel')).toHaveCount(0);
    const before = await win.evaluate(() => window.api.invoke('fleet:get-state', undefined));
    expect(before.enabled).toBe(false);
    const sheetDiscovery = panel.getByRole('switch', { name: 'Enable Fleet discovery' });
    await expect(sheetDiscovery).not.toBeChecked();
    const title = await panel.getByRole('heading', { name: 'Fleet' }).boundingBox();
    const toggle = await sheetDiscovery.boundingBox();
    expect(title && toggle && Math.abs((title.y + title.height / 2) - (toggle.y + toggle.height / 2))).toBeLessThanOrEqual(1);
    await sheetDiscovery.click();
    await expect(sheetDiscovery).toBeChecked();
    await expect.poll(async () => (await win.evaluate(() => window.api.invoke('fleet:get-state', undefined))).enabled).toBe(true);
    await expect(panel.getByRole('button', { name: 'Open Fleet settings' })).toHaveCount(0);
    await win.getByTestId('settings-open').click();
    const settings = win.getByRole('dialog', { name: 'Settings' });
    await expect(settings).toBeVisible();
    const fleetSection = settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Fleet' });
    await fleetSection.click();
    await expect(fleetSection).toHaveAttribute('aria-current', 'page');
    await expect(settings.getByRole('switch', { name: 'Enable Fleet discovery' })).toHaveCount(0);
    await expect(settings.getByRole('spinbutton', { name: 'Fleet port' })).toBeVisible();
    await expect(settings.getByText('Default: 43872')).toBeVisible();
    await win.getByTestId('settings-done').click();
    await win.getByTestId('ab-projects').click();
    await expect.poll(async () => (await win.evaluate(() => window.api.invoke('fleet:get-state', undefined))).enabled).toBe(true);
    await win.getByTestId('ab-fleet').click();
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
    await expect(sheetDiscovery).toBeChecked();
    await sheetDiscovery.click();
    await expect(sheetDiscovery).not.toBeChecked();
    await expect.poll(async () => (await win.evaluate(() => window.api.invoke('fleet:get-state', undefined))).enabled).toBe(false);
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
    const terminal = win.locator('main .xterm');
    await win.getByTestId('ab-fleet').click();
    await expect(win.getByTestId('fleet-panel')).toBeVisible();
    await expect(sidebar).toBeHidden();
    await expect(terminal).toBeAttached();
    await win.getByTestId('ab-fleet').click();
    await expect(win.getByTestId('fleet-panel')).toBeHidden();
    await expect(terminal).toBeVisible();
    await expect.poll(() => win.title()).toBe('Local Fleet Project — MetaLogix IDE');
    expect(await win.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      await win.evaluate(() => window.innerWidth),
    );
  } finally {
    await closeApp(app);
    cleanup();
  }
});

async function isolateFleetCredentials(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const modules = process.getBuiltinModule('module');
    if (!modules) throw new Error('Node module loader unavailable');
    const keytar: typeof Keytar = modules.createRequire(`${process.cwd()}/package.json`)('keytar');
    const credentials = new Map<string, string>();
    keytar.getPassword = async (service, account) => credentials.get(`${service}:${account}`) ?? null;
    keytar.setPassword = async (service, account, password) => { credentials.set(`${service}:${account}`, password); };
  });
}

/** This host does not loop multicast back to a second local UDP socket. Only public
 * discovery beacons are injected; pairing, trust, shell operations and PTY traffic
 * still traverse the two Electron processes' real TLS channels. */
async function publicBeacon(app: ElectronApplication): Promise<{ v: 1; id: string; name: string; port: number } | null> {
  return app.evaluate(async () => {
    const crypto = process.getBuiltinModule('crypto');
    const path = process.getBuiltinModule('path');
    const tls = process.getBuiltinModule('tls');
    const os = process.getBuiltinModule('os');
    const modules = process.getBuiltinModule('module');
    if (!crypto || !path || !tls || !os || !modules) throw new Error('Node builtins unavailable');
    const keytar: typeof Keytar = modules.createRequire(`${process.cwd()}/package.json`)('keytar');
    const directory = path.resolve(path.join(process.env.HOME ?? '', '.metaide', 'fleet'));
    const account = `tls-v1:${crypto.createHash('sha256').update(directory).digest('hex')}`;
    const saved = await keytar.getPassword('metaIDE.fleet.identity', account);
    if (!saved) return null;
    const cert = (JSON.parse(saved) as { cert: string }).cert;
    const id = crypto.createHash('sha256').update(new crypto.X509Certificate(cert).raw).digest('hex');
    const handles = (process as NodeJS.Process & { _getActiveHandles: () => object[] })._getActiveHandles();
    const server = handles.find((handle): handle is import('node:tls').Server => handle instanceof tls.Server);
    const address = server?.address();
    if (!address || typeof address === 'string') return null;
    return { v: 1 as const, id, name: os.hostname(), port: address.port };
  });
}

async function announcePublicBeacon(app: ElectronApplication, beacon: { v: 1; id: string; name: string; port: number }): Promise<void> {
  await app.evaluate((_, presence) => {
    const dgram = process.getBuiltinModule('dgram');
    if (!dgram) throw new Error('UDP discovery unavailable');
    const handles = (process as NodeJS.Process & { _getActiveHandles: () => object[] })._getActiveHandles();
    const socket = handles.find((handle): handle is import('node:dgram').Socket =>
      handle instanceof dgram.Socket && handle.address().port === 43871);
    if (!socket) throw new Error('Fleet UDP listener unavailable');
    const bytes = Buffer.from(JSON.stringify(presence));
    socket.emit('message', bytes, { address: '127.0.0.1', family: 'IPv4', port: 43871, size: bytes.length });
  }, beacon);
}

async function fleetPeer(win: Page, status: 'discovered' | 'pending' | 'linked'): Promise<{ id: string; verificationCode?: string } | null> {
  const state = await win.evaluate(() => window.api.invoke('fleet:get-state', undefined));
  return state.peers.find((peer) => peer.status === status) ?? null;
}

async function remoteShellSize(controller: Page, driven: Page, projectId: number): Promise<{ cols: number; rows: number }> {
  const marker = /size: (\d+)x(\d+)/g;
  const output = async () => {
    const snapshot = await driven.evaluate((id) => window.api.invoke('shells:snapshot', { projectId: id, shellIndex: 0 }), projectId);
    return [...snapshot.output.matchAll(marker)].map((match) => ({ cols: Number(match[1]), rows: Number(match[2]) }));
  };
  const count = (await output()).length;
  await controller.locator('main .xterm').click();
  await controller.keyboard.type('/size');
  await controller.keyboard.press('Enter');
  let sizes: Array<{ cols: number; rows: number }> = [];
  await expect.poll(async () => { sizes = await output(); return sizes.length; }).toBeGreaterThan(count);
  const current = sizes.at(-1);
  if (!current) throw new Error('Remote PTY did not report its viewport');
  return current;
}

test('paired Electron instances show remote root folders and hand viewport control back on detach', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const driver = await launch([]);
  let driven: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    driven = await launch(['Driven Fleet Project']);
    await isolateFleetCredentials(driver.app);
    await isolateFleetCredentials(driven.app);
    await driven.win.getByTestId('project-row').filter({ hasText: 'Driven Fleet Project' }).click();
    await expect(driven.win.locator('main .xterm')).toBeVisible();
    const { projects } = await driven.win.evaluate(() => window.api.invoke('projects:list', undefined));
    const project = projects.find((entry) => entry.name === 'Driven Fleet Project');
    if (!project) throw new Error('Driven project missing');
    await driver.win.getByRole('button', { name: 'Fleet', exact: true }).click();
    await driven.win.getByRole('button', { name: 'Fleet', exact: true }).click();
    await driver.win.getByRole('switch', { name: 'Enable Fleet discovery' }).click();
    await driven.win.getByRole('switch', { name: 'Enable Fleet discovery' }).click();
    await expect.poll(async () => (await publicBeacon(driver.app))?.id ?? null, { timeout: 20_000 }).not.toBeNull();
    await expect.poll(async () => (await publicBeacon(driven.app))?.id ?? null, { timeout: 20_000 }).not.toBeNull();
    const driverBeacon = await publicBeacon(driver.app);
    const drivenBeacon = await publicBeacon(driven.app);
    if (!driverBeacon || !drivenBeacon) throw new Error('Fleet TLS listeners unavailable');
    await announcePublicBeacon(driver.app, drivenBeacon);
    await announcePublicBeacon(driven.app, driverBeacon);
    await expect.poll(async () => (await fleetPeer(driver.win, 'discovered'))?.id ?? null, { timeout: 20_000 }).not.toBeNull();
    await expect.poll(async () => (await fleetPeer(driven.win, 'discovered'))?.id ?? null, { timeout: 20_000 }).not.toBeNull();
    const controllerPeer = await fleetPeer(driver.win, 'discovered');
    if (!controllerPeer) throw new Error('Driven instance was not discovered');
    await driver.win.getByRole('button', { name: 'Request link' }).click();
    await expect.poll(async () => (await fleetPeer(driver.win, 'pending'))?.verificationCode ?? null).not.toBeNull();
    const code = (await fleetPeer(driver.win, 'pending'))?.verificationCode;
    if (!code) throw new Error('No comparison code on driving instance');
    await expect.poll(async () => (await fleetPeer(driven.win, 'pending'))?.verificationCode).toBe(code);
    await driver.win.getByRole('textbox', { name: /Matching code for/ }).fill(code);
    await driven.win.getByRole('textbox', { name: /Matching code for/ }).fill(code);
    await driver.win.getByRole('button', { name: 'Approve link' }).click();
    await driven.win.getByRole('button', { name: 'Approve link' }).click();
    await expect.poll(async () => (await fleetPeer(driver.win, 'linked'))?.id ?? null).toBe(controllerPeer.id);
    const machine = driver.win.getByTestId(`fleet-machine-${controllerPeer.id}`);
    await expect(machine).toContainText(basename(driven.demoRoot));
    await expect(machine.getByTestId('remote-project-row')).toContainText('Driven Fleet Project');
    await machine.getByTestId('remote-project-row').click();
    await expect(driver.win.locator('main .xterm')).toBeVisible();
    await expect(driven.win.getByText(/terminal is controlled remotely by/)).toBeVisible();
    await expect(driven.win.locator('main .xterm')).toHaveCount(0);
    await expect(driver.win.getByRole('button', { name: 'Paste', exact: true })).toBeEnabled();
    const wide = await remoteShellSize(driver.win, driven.win, project.id);
    await testInfo.attach('driving-instance-folders', { body: await driver.win.screenshot(), contentType: 'image/png' });
    await testInfo.attach('driven-instance-control-notice', { body: await driven.win.screenshot(), contentType: 'image/png' });
    await driver.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(900, 700); });
    await expect.poll(async () => (await remoteShellSize(driver.win, driven.win, project.id)).cols, { timeout: 15_000 }).toBeLessThan(wide.cols);
    const narrow = await remoteShellSize(driver.win, driven.win, project.id);
    await driven.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(900, 700); });
    await driven.win.evaluate((id) => window.api.invoke('shells:resize', { projectId: id, shellIndex: 0, cols: 42, rows: 16 }), project.id);
    expect(await remoteShellSize(driver.win, driven.win, project.id)).toEqual(narrow);
    await driver.win.getByRole('button', { name: 'Fleet', exact: true }).click();
    await driver.win.getByRole('switch', { name: 'Enable Fleet discovery' }).click();
    await expect(driven.win.getByText(/terminal is controlled remotely by/)).toHaveCount(0);
    await expect(driven.win.locator('main .xterm')).toBeVisible();
  } finally {
    if (driven) { await closeApp(driven.app); driven.cleanup(); }
    await closeApp(driver.app);
    driver.cleanup();
  }
});
