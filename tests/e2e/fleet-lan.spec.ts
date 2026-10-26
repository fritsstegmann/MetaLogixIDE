import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { basename } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import type * as Keytar from 'keytar';
import { aliveShells, closeApp, launch } from './helpers/claude-harness';
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
      BrowserWindow.getAllWindows()[0]!.setContentSize(390, 844);
    });
    await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(390);
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

async function reserveAvailablePort(): Promise<number> {
  const server = createServer();
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP port available for Fleet test');
  const closed = once(server, 'close');
  server.close();
  await closed;
  return address.port;
}

async function chooseFleetPort(win: Page): Promise<void> {
  const port = await reserveAvailablePort();
  await win.getByTestId('settings-open').click();
  const settings = win.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Fleet' }).click();
  await settings.getByRole('spinbutton', { name: 'Fleet port' }).fill(String(port));
  await settings.getByRole('button', { name: 'Save port' }).click();
  await expect.poll(async () => (await win.evaluate(() => window.api.invoke('fleet:get-state', undefined))).port).toBe(port);
  await win.getByTestId('settings-done').click();
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
    // Stored as `b64v1:` + base64(JSON); unprefixed values are the legacy plain-JSON form.
    const json = saved.startsWith('b64v1:') ? Buffer.from(saved.slice('b64v1:'.length), 'base64').toString('utf8') : saved;
    const cert = (JSON.parse(json) as { cert: string }).cert;
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
    const drivenWin = driven.win;
    const drivenApp = driven.app;
    await isolateFleetCredentials(driver.app);
    await isolateFleetCredentials(driven.app);
    await driven.win.getByTestId('project-row').filter({ hasText: 'Driven Fleet Project' }).click();
    await expect(driven.win.locator('main .xterm')).toBeVisible();
    const { projects } = await driven.win.evaluate(() => window.api.invoke('projects:list', undefined));
    const project = projects.find((entry) => entry.name === 'Driven Fleet Project');
    if (!project) throw new Error('Driven project missing');
    await chooseFleetPort(driver.win);
    await chooseFleetPort(driven.win);
    await driver.win.getByRole('button', { name: 'Fleet', exact: true }).click();
    await driven.win.getByRole('button', { name: 'Fleet', exact: true }).click();
    await driver.win.getByRole('switch', { name: 'Enable Fleet discovery' }).click();
    await driven.win.getByRole('switch', { name: 'Enable Fleet discovery' }).click();
    await expect.poll(async () => (await publicBeacon(driver.app))?.id ?? null, { timeout: 20_000 }).not.toBeNull();
    await expect.poll(async () => (await publicBeacon(drivenApp))?.id ?? null, { timeout: 20_000 }).not.toBeNull();
    const driverBeacon = await publicBeacon(driver.app);
    const drivenBeacon = await publicBeacon(driven.app);
    if (!driverBeacon || !drivenBeacon) throw new Error('Fleet TLS listeners unavailable');
    await announcePublicBeacon(driver.app, drivenBeacon);
    await announcePublicBeacon(driven.app, driverBeacon);
    await expect.poll(async () => (await fleetPeer(driver.win, 'discovered'))?.id ?? null, { timeout: 20_000 }).not.toBeNull();
    await expect.poll(async () => (await fleetPeer(drivenWin, 'discovered'))?.id ?? null, { timeout: 20_000 }).not.toBeNull();
    const controllerPeer = await fleetPeer(driver.win, 'discovered');
    if (!controllerPeer) throw new Error('Driven instance was not discovered');
    await driver.win.getByRole('button', { name: 'Request link' }).click();
    await expect.poll(async () => (await fleetPeer(driver.win, 'pending'))?.verificationCode ?? null).not.toBeNull();
    const code = (await fleetPeer(driver.win, 'pending'))?.verificationCode;
    if (!code) throw new Error('No comparison code on driving instance');
    await expect.poll(async () => (await fleetPeer(drivenWin, 'pending'))?.verificationCode).toBe(code);
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
    const workspace = driver.win.getByTestId('remote-workspace');
    const tabs = workspace.getByTestId('shell-tab-button');
    await expect(tabs).toHaveCount(1);
    await expect(workspace.getByRole('button', { name: 'Shell', exact: true })).toHaveCount(0);
    await expect(tabs.first()).toContainText('Claude');
    await workspace.getByTestId('tabbar-new-shell').click();
    const addShell = workspace.locator('[data-new-shell-menu="1"]');
    await expect(addShell.getByRole('button', { name: /Claude/ }).first()).toBeVisible();
    await addShell.getByRole('button', { name: /Terminal/ }).click();
    await expect(tabs).toHaveCount(2);
    await expect(tabs.last()).toContainText('Terminal');
    await expect(workspace.locator('.xterm')).toBeVisible();
    await workspace.getByTestId('tabbar-new-shell').click();
    await addShell.getByRole('button', { name: /Claude/ }).first().click();
    await expect(tabs).toHaveCount(3);
    await expect(tabs.last()).toContainText('Claude');
    await tabs.first().click();
    await expect(workspace.locator('.xterm').first()).toBeVisible();
    await expect(driven.win.getByText(/terminal is controlled remotely by/)).toBeVisible();
    // Shell 0's notice SHOULD disappear once shell 1 owns control. Instead
    // record every driven Fleet state during handoff: at least one shell in
    // this project must remain controlled at all times.
    const notice = drivenWin.getByRole('status', { name: 'Terminal controlled remotely' });
    await expect(notice).toBeVisible();
    const secondIndex = Number(await tabs.nth(1).getAttribute('data-shell-index'));
    expect(secondIndex, 'positive control: the existing second tab is distinct from shell 0').toBeGreaterThan(0);
    // Populate the already-running second PTY while shell 0 remains on
    // screen. Both markers must survive the driven screen mirror's snapshot.
    const newest = `REMOTE-NEWEST-${Date.now()}`;
    await drivenWin.evaluate(({ id, index, marker }) =>
      window.api.invoke('shells:write', {
        projectId: id, shellIndex: index,
        data: `for i in $(seq 1 180); do printf 'remote-line-%03d\\n' "$i"; done; printf '${marker}\\n'\r`,
      }),
    { id: project.id, index: secondIndex, marker: newest });
    await expect.poll(async () => (await drivenWin.evaluate(({ id, index }) =>
      window.api.invoke('shells:snapshot', { projectId: id, shellIndex: index }),
    { id: project.id, index: secondIndex })).output, { message: 'driven PTY finishes all 180 output lines' })
      .toContain('remote-line-180');
    const serialized = await drivenWin.evaluate(({ id, index }) =>
      window.api.invoke('shells:snapshot', { projectId: id, shellIndex: index }),
    { id: project.id, index: secondIndex });
    expect(serialized.output, 'positive control: serialized remote scrollback retains older content')
      .toContain('remote-line-001');
    expect(serialized.output, 'positive control: serialized remote scrollback contains newest output')
      .toContain(newest);
    await drivenWin.evaluate(async ({ projectId, target }) => {
      const state = await window.api.invoke('fleet:get-state', undefined);
      if (!state.controls.some((control) => control.projectId === projectId && control.shellIndex === 0))
        throw new Error('Positive control: driven shell 0 must begin under remote control');
      let gap = false;
      let seenTarget = false;
      const off = window.api.on('fleet:changed', (next) => {
        const indices = next.controls.filter((control) => control.projectId === projectId)
          .map((control) => control.shellIndex);
        if (indices.length === 0) gap = true;
        if (indices.includes(target)) seenTarget = true;
      });
      Object.assign(window, { __fleetControlWatch: {
        get gap() { return gap; },
        get seenTarget() { return seenTarget; },
        off,
      } });
    }, { projectId: project.id, target: secondIndex });
    // Sample the replacement pane, not the retained shell-0 pane. Freeze
    // its first visible rAF before the click; later scroll settling cannot
    // turn a bad first frame green.
    await driver.win.evaluate(() => {
      type Viewport = { scroll: number; max: number; height: number };
      const root = document.querySelector('[data-testid="remote-workspace"]');
      const old = root?.querySelector('[role="region"][aria-label^="Terminal for "]');
      if (!root || !old) throw new Error('Positive control: remote shell 0 is mounted before handoff');
      const watch: { first: Viewport | null; expired: boolean } = { first: null, expired: false };
      Object.assign(window, { __remoteFirstVisible: watch });
      const deadline = performance.now() + 10_000;
      const sample = () => {
        const replacement = [...root.querySelectorAll<HTMLElement>('[role="region"][aria-label^="Terminal for "]')]
          .find((region) => region !== old && region.parentElement?.getAttribute('aria-hidden') === 'false' &&
            getComputedStyle(region.parentElement).visibility === 'visible');
        const viewport = replacement?.querySelector<HTMLElement>('.xterm-viewport');
        if (replacement && viewport && viewport.getClientRects().length > 0) {
          watch.first = {
            scroll: viewport.scrollTop,
            max: viewport.scrollHeight - viewport.clientHeight,
            height: viewport.clientHeight,
          };
        } else if (performance.now() < deadline) requestAnimationFrame(sample);
        else watch.expired = true;
      };
      requestAnimationFrame(sample);
    });
    await tabs.nth(1).click();
    await expect(workspace.locator('.xterm').first()).toBeVisible();
    await expect(workspace.locator('[data-shell-index]').filter({ hasText: 'Terminal' }).first())
      .toHaveAttribute('data-shell-index', String(secondIndex));
    await expect.poll(() => driver.win.evaluate(() => (window as typeof window & {
      __remoteFirstVisible?: { first: { scroll: number; max: number; height: number } | null };
    }).__remoteFirstVisible?.first ?? null), { timeout: 11_000 }).not.toBeNull();
    const firstRemote = await driver.win.evaluate(() => (window as typeof window & {
      __remoteFirstVisible?: { first: { scroll: number; max: number; height: number } | null };
    }).__remoteFirstVisible?.first);
    if (!firstRemote) throw new Error('First visible replacement viewport was not sampled');
    expect(firstRemote.height, 'positive control: first replacement pane is laid out').toBeGreaterThan(0);
    expect(firstRemote.max, 'first visible remote viewport already contains parsed scrollback').toBeGreaterThan(0);
    expect(firstRemote.scroll, `first visible remote viewport starts at newest content (bottom=${firstRemote.max})`)
      .toBeGreaterThanOrEqual(firstRemote.max - 1);
    await expect(notice, 'shell-0 notice correctly ends when the second shell takes control').toHaveCount(0);
    await expect.poll(() => drivenWin.evaluate(() => (window as typeof window & {
      __fleetControlWatch?: { seenTarget: boolean };
    }).__fleetControlWatch?.seenTarget)).toBe(true);
    expect(await drivenWin.evaluate(() => (window as typeof window & {
      __fleetControlWatch?: { gap: boolean };
    }).__fleetControlWatch?.gap), 'no Fleet control gap while selecting the second tab').toBe(false);
    expect((await fleetPeer(driver.win, 'linked'))?.id, 'both apps remain paired').toBe(controllerPeer.id);
    expect((await fleetPeer(driven.win, 'linked'))?.id, 'driven app remains paired').toBe(driverBeacon.id);

    // Split is an independent right-hand PTY, not a tab switch. Assert the
    // selected left shell by sending distinct commands to both real PTYs.
    const beforeSplit = (await aliveShells(driven.win)).filter((shell) => shell.projectId === project.id).map((shell) => shell.shellIndex);
    await workspace.getByTestId('tabbar-split').click();
    const right = workspace.getByTestId('split-right');
    await expect(right.locator('.xterm')).toBeVisible();
    let rightIndex: number | undefined;
    await expect.poll(async () => {
      rightIndex = (await aliveShells(drivenWin))
        .find((shell) => shell.projectId === project.id && !beforeSplit.includes(shell.shellIndex))?.shellIndex;
      return rightIndex;
    }, { message: 'Split starts a separate shell on the linked machine' }).toBeGreaterThan(secondIndex);
    if (rightIndex === undefined) throw new Error('Split shell missing on driven instance');
    const splitShellIndex = rightIndex;
    await expect(tabs.nth(1)).toHaveAttribute('data-shell-index', String(secondIndex));
    await expect(tabs).toHaveCount(3);
    const left = workspace.getByRole('region', { name: /Terminal for Driven Fleet Project on/ });
    await expect(right.locator('.xterm-helper-textarea'), 'positive control: new right pane finished attaching')
      .toBeFocused();
    await expect(left.locator('.xterm')).toBeVisible();
    const leftMarker = `left-${Date.now()}`;
    const rightMarker = `right-${Date.now()}`;
    await left.locator('.xterm').click();
    await driver.win.keyboard.type(`echo ${leftMarker}`);
    await driver.win.keyboard.press('Enter');
    await expect.poll(async () => (await drivenWin.evaluate(({ id, index }) =>
      window.api.invoke('shells:snapshot', { projectId: id, shellIndex: index }), { id: project.id, index: secondIndex })).output)
      .toContain(leftMarker);
    await right.locator('.xterm').click();
    await driver.win.keyboard.type(`echo ${rightMarker}`);
    await driver.win.keyboard.press('Enter');
    await expect.poll(async () => (await drivenWin.evaluate(({ id, index }) =>
      window.api.invoke('shells:snapshot', { projectId: id, shellIndex: index }), { id: project.id, index: splitShellIndex })).output)
      .toContain(rightMarker);
    const leftOutput = await drivenWin.evaluate(({ id, index }) =>
      window.api.invoke('shells:snapshot', { projectId: id, shellIndex: index }), { id: project.id, index: secondIndex });
    expect(leftOutput.output, 'right pane did not route input into the selected left shell').not.toContain(rightMarker);
    await expect.poll(() => drivenWin.evaluate((id) => window.api.invoke('fleet:get-state', undefined)
      .then((state) => state.controls.filter((control) => control.projectId === id).map((control) => control.shellIndex)),
    project.id)).toEqual(expect.arrayContaining([secondIndex, rightIndex]));
    expect(await drivenWin.evaluate(() => (window as typeof window & {
      __fleetControlWatch?: { gap: boolean };
    }).__fleetControlWatch?.gap), 'split must not leave the driven project without remote control').toBe(false);
    expect((await fleetPeer(driver.win, 'linked'))?.id).toBe(controllerPeer.id);
    expect((await fleetPeer(driven.win, 'linked'))?.id).toBe(driverBeacon.id);
    await workspace.getByTestId('tabbar-split').click();
    await expect(right).toHaveCount(0);
    await tabs.first().click();
    await expect(notice).toBeVisible();
    await expect(driven.win.locator('main .xterm')).toHaveCount(0);
    expect(await drivenWin.evaluate(() => (window as typeof window & {
      __fleetControlWatch?: { gap: boolean };
    }).__fleetControlWatch?.gap), 'returning to shell 0 also keeps continuous remote control').toBe(false);
    await expect(driver.win.getByRole('button', { name: 'Paste', exact: true })).toBeEnabled();
    const wide = await remoteShellSize(driver.win, driven.win, project.id);
    await testInfo.attach('driving-instance-folders', { body: await driver.win.screenshot(), contentType: 'image/png' });
    await testInfo.attach('driven-instance-control-notice', { body: await driven.win.screenshot(), contentType: 'image/png' });
    await driver.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(900, 700); });
    await expect.poll(async () => (await remoteShellSize(driver.win, drivenWin, project.id)).cols, { timeout: 15_000 }).toBeLessThan(wide.cols);
    const narrow = await remoteShellSize(driver.win, driven.win, project.id);
    await driven.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(900, 700); });
    await driven.win.evaluate((id) => window.api.invoke('shells:resize', { projectId: id, shellIndex: 0, cols: 42, rows: 16 }), project.id);
    expect(await remoteShellSize(driver.win, driven.win, project.id)).toEqual(narrow);
    await driver.win.getByRole('button', { name: 'Fleet', exact: true }).click();
    await driver.win.getByRole('switch', { name: 'Enable Fleet discovery' }).click();
    await expect(driven.win.getByText(/terminal is controlled remotely by/)).toHaveCount(0);
    await expect(driven.win.locator('main .xterm')).toBeVisible();
    // Positive control: intentionally unlinking ends every remote control
    // and the event recorder detects the very zero-control state it rejects.
    await expect.poll(() => drivenWin.evaluate(() => (window as typeof window & {
      __fleetControlWatch?: { gap: boolean };
    }).__fleetControlWatch?.gap)).toBe(true);
    await drivenWin.evaluate(() => {
      (window as typeof window & { __fleetControlWatch?: { off: () => void } }).__fleetControlWatch?.off();
    });
  } finally {
    if (driven) { await closeApp(driven.app); driven.cleanup(); }
    await closeApp(driver.app);
    driver.cleanup();
  }
});
