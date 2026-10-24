/**
 * Fleet credential-store corruption on Linux (gnome-keyring plaintext round-trip):
 * the stored identity is written as `b64v1:` + base64, a gnome-mangled legacy
 * JSON entry still loads and is rewritten, and an identity missing while trust
 * exists offers Reset identity instead of leaving Fleet stuck.
 *
 * Runs against the real Electron app. keytar is replaced in the main process by
 * an in-memory store (helpers/fleet-credentials.ts); the OS keyring is never used.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeApp } from './helpers/claude-harness';
import {
  fakeFingerprint,
  fleetDir,
  generateFleetIdentity,
  isolateFleetKeytar,
  launchFleet,
  reserveFleetPort,
  seedStoredIdentity,
  seedTrust,
  storedIdentity,
} from './helpers/fleet-credentials';
import type { FleetState } from '../../src/shared/fleet-contract';
import type {} from '../../src/renderer/api';

const ENCODED = /^b64v1:[A-Za-z0-9+/=]+$/;
const MISSING_IDENTITY_MESSAGE =
  'Fleet identity is missing from the credential store. Reset identity to create a new one; paired devices must pair again.';

async function fleetState(win: Page): Promise<FleetState> {
  return win.evaluate(() => window.api.invoke('fleet:get-state', undefined));
}

/** Moves the listener off the shared default port, then opens the Fleet panel. */
async function openFleetPanel(win: Page): Promise<void> {
  const port = await reserveFleetPort();
  await win.evaluate((value) => window.api.invoke('fleet:set-port', { port: value }), port);
  await win.getByRole('button', { name: 'Fleet', exact: true }).click();
  await expect(win.getByTestId('fleet-panel')).toBeVisible();
}

function decodeStored(value: string): { cert: string; key: string } {
  return JSON.parse(Buffer.from(value.slice('b64v1:'.length), 'base64').toString('utf8')) as { cert: string; key: string };
}

test('AC1: first enable on a clean credential store stores the identity as b64v1 base64', async () => {
  const { app, win, home, cleanup } = await launchFleet();
  try {
    await isolateFleetKeytar(app);
    expect(await storedIdentity(app, home)).toBeNull();
    await openFleetPanel(win);
    const panel = win.getByTestId('fleet-panel');
    const toggle = panel.getByRole('switch', { name: 'Enable Fleet discovery' });
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect.poll(async () => (await fleetState(win)).enabled).toBe(true);

    const stored = await storedIdentity(app, home);
    expect(stored).toMatch(ENCODED);
    // Positive control for the "no backslash / control character" claim: the payload decodes to the PEM pair.
    const { cert, key } = decodeStored(stored!);
    expect(cert).toContain('-----BEGIN CERTIFICATE-----');
    expect(key).toContain('-----BEGIN PRIVATE KEY-----');
    expect(stored).not.toMatch(/[\\\u0000-\u001f\u007f]/);

    const state = await fleetState(win);
    expect(state.enabled).toBe(true);
    expect(state.recovery).toBeUndefined();
    expect(state.error).toBeUndefined();
  } finally {
    await closeApp(app);
    cleanup();
  }
});

test('AC2: a gnome-mangled legacy identity loads without recovery and is rewritten as b64v1', async () => {
  const peer = { id: fakeFingerprint(), name: 'Seeded Peer' };
  const identity = await generateFleetIdentity();
  // gnome-keyring's plaintext read turns the JSON `\n` escapes into raw newlines.
  const legacyJson = JSON.stringify({ cert: identity.cert, key: identity.key });
  const mangled = legacyJson.replace(/\\n/g, '\n');
  // Seed self-checks: the value is genuinely the broken shape, not valid JSON.
  expect(mangled).not.toBe(legacyJson);
  expect(mangled).toContain('\n');
  expect(mangled).not.toContain('\\');
  expect(() => JSON.parse(mangled) as unknown).toThrow();

  const { app, win, home, cleanup } = await launchFleet((dir) => seedTrust(dir, { enabled: false, trusted: [peer], revoked: [] }));
  try {
    await isolateFleetKeytar(app);
    await seedStoredIdentity(app, home, mangled);
    await openFleetPanel(win);
    const panel = win.getByTestId('fleet-panel');
    const toggle = panel.getByRole('switch', { name: 'Enable Fleet discovery' });
    await toggle.click();
    await expect(toggle).toBeChecked();

    const state = await fleetState(win);
    // Positive controls in the same response: enabled, and the seeded trust survived.
    expect(state.enabled).toBe(true);
    // toContainEqual: a real IDE on this LAN may also be discovered once the listener is up.
    expect(state.peers).toContainEqual({ id: peer.id, name: peer.name, status: 'offline' });
    expect(state.recovery).toBeUndefined();
    expect(state.error).toBeUndefined();
    // Same render: the peer row is shown and no Reset identity is offered.
    await expect(panel.getByRole('list', { name: 'Fleet machines' })).toContainText(peer.name);
    await expect(panel.getByRole('button', { name: /Reset identity|Confirm reset/ })).toHaveCount(0);

    // Rewritten encoded, and it is the same identity, not a freshly generated one.
    const stored = await storedIdentity(app, home);
    expect(stored).toMatch(ENCODED);
    const rewritten = decodeStored(stored!);
    expect(rewritten.cert).toBe(identity.cert);
    expect(rewritten.key).toBe(identity.key);
  } finally {
    await closeApp(app);
    cleanup();
  }
});

test('AC4: identity missing while trust exists offers Reset identity; confirming leaves Fleet off with no peers', async () => {
  const peer = { id: fakeFingerprint(), name: 'Seeded Peer' };
  const { app, win, home, cleanup } = await launchFleet((dir) => seedTrust(dir, { enabled: false, trusted: [peer], revoked: [] }));
  try {
    await isolateFleetKeytar(app);
    expect(await storedIdentity(app, home)).toBeNull();
    // Positive control for the seed: the app loaded the trusted peer at startup.
    const before = await fleetState(win);
    expect(before.enabled).toBe(false);
    expect(before.peers.map((p) => p.id)).toEqual([peer.id]);
    expect(before.recovery).toBeUndefined();

    await openFleetPanel(win);
    const panel = win.getByTestId('fleet-panel');
    const toggle = panel.getByRole('switch', { name: 'Enable Fleet discovery' });
    await toggle.click();

    const reset = panel.getByRole('button', { name: 'Reset identity', exact: true });
    await expect(reset).toBeVisible();
    await expect(toggle).not.toBeChecked();
    const failed = await fleetState(win);
    expect(failed.recovery).toBe('reset-identity');
    expect(failed.enabled).toBe(false);
    // Specific to the missing case, distinct from the "unreadable" credential message.
    expect(failed.error).toBe(MISSING_IDENTITY_MESSAGE);
    await expect(panel.getByRole('alert').filter({ hasText: failed.error! })).toBeVisible();
    // Failing to enable must not create an identity or drop trust.
    expect(await storedIdentity(app, home)).toBeNull();
    expect(failed.peers.map((p) => p.id)).toEqual([peer.id]);

    // Two-step: the first click only arms the button.
    await reset.click();
    const confirm = panel.getByRole('button', { name: 'Confirm reset — paired devices must pair again' });
    await expect(confirm).toBeVisible();
    expect((await fleetState(win)).recovery).toBe('reset-identity');
    await confirm.click();

    await expect(panel.getByText('Fleet is off. Turn on the switch above to find IDEs on your local network.')).toBeVisible();
    await expect(panel.getByRole('button', { name: /Reset identity|Confirm reset/ })).toHaveCount(0);
    await expect(toggle).not.toBeChecked();
    const after = await fleetState(win);
    expect(after.enabled).toBe(false);
    expect(after.peers).toEqual([]);
    expect(after.recovery).toBeUndefined();
    expect(after.error).toBeUndefined();

    // Effects: a fresh encoded identity exists and the persisted trust has no peers.
    expect(await storedIdentity(app, home)).toMatch(ENCODED);
    const trust = JSON.parse(readFileSync(join(fleetDir(home), 'trust.json'), 'utf8')) as { enabled: boolean; trusted: unknown[] };
    expect(trust.enabled).toBe(false);
    expect(trust.trusted).toEqual([]);
  } finally {
    await closeApp(app);
    cleanup();
  }
});
