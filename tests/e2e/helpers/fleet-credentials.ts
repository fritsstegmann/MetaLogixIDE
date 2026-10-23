/**
 * Fleet credential-store seams for E2E: a launch whose isolated HOME can be
 * seeded before the app starts (Fleet reads `~/.metaide/fleet/trust.json` at
 * startup), an in-memory keytar replacement whose contents the spec can read
 * and seed, and a generator for a valid self-signed Fleet identity.
 *
 * The real OS keyring is never touched: every keytar call the app makes after
 * `isolateFleetKeytar` resolves against a Map held on the main process's
 * globalThis. Install it before enabling Fleet — trust seeded with
 * `enabled: false` keeps startup from loading the identity.
 */
import 'reflect-metadata';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createHash, createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import { delimiter, join } from 'node:path';
import { X509CertificateGenerator } from '@peculiar/x509';
import type * as Keytar from 'keytar';
import { baseEnv, guardedLaunch, makeClaudeShim } from './claude-harness';

export const FLEET_SERVICE = 'metaIDE.fleet.identity';

/** Key on the Electron main process's globalThis holding the in-memory credential Map. */
const STORE_KEY = '__metaideE2eFleetCredentials';

export interface SeededTrust {
  readonly enabled: boolean;
  readonly trusted: readonly { readonly id: string; readonly name: string }[];
  readonly revoked: readonly string[];
}

export interface FleetHarness {
  app: ElectronApplication;
  win: Page;
  home: string;
  cleanup: () => void;
}

/** `~/.metaide/fleet` under the isolated HOME, as the app resolves it. */
export function fleetDir(home: string): string {
  return join(home, '.metaide', 'fleet');
}

/** Writes trust.json with the owner-only modes the identity store insists on. */
export function seedTrust(home: string, trust: SeededTrust): void {
  const dir = fleetDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, 'trust.json');
  writeFileSync(path, JSON.stringify(trust), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Launches the app like `claude-harness.launch([])`, but runs `seed(home)`
 * before Electron starts so files Fleet reads at startup are already present.
 */
export async function launchFleet(seed: (home: string) => void = () => undefined): Promise<FleetHarness> {
  return guardedLaunch(async (scope) => {
    const home = scope.tempDir('metaide-fleet-cred-home-');
    const shimPath = makeClaudeShim(home);
    seed(home);
    const app = scope.own(await electron.launch({
      ...(process.env.METAIDE_PACKAGED_APP ? { executablePath: process.env.METAIDE_PACKAGED_APP } : {}),
      args: [...(process.env.METAIDE_PACKAGED_APP ? [] : ['.']), `--user-data-dir=${join(home, 'userData')}`],
      env: {
        ...baseEnv(),
        HOME: home,
        ...(process.platform === 'win32' ? { USERPROFILE: home } : { SHELL: '/bin/bash' }),
        PATH: `${join(home, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
        METAIDE_TEST_MODE: '1',
        METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
        METAIDE_DEFAULT_LAUNCH_FIRST: JSON.stringify({ argv: [shimPath], env: {} }),
        METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: [shimPath, '--continue'], env: {} }),
      },
    }));
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1400, 900); });
    return { app, win, home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
  });
}

/**
 * Replaces keytar's get/set/delete in the app's main process with an in-memory
 * Map exposed on globalThis, so the spec can seed and read stored values.
 */
export async function isolateFleetKeytar(app: ElectronApplication): Promise<void> {
  await app.evaluate((_electron, storeKey) => {
    const modules = process.getBuiltinModule('module');
    if (!modules) throw new Error('Node module loader unavailable');
    const keytar: typeof Keytar = modules.createRequire(`${process.cwd()}/package.json`)('keytar');
    const credentials = new Map<string, string>();
    (globalThis as Record<string, unknown>)[storeKey] = credentials;
    keytar.getPassword = async (service, account) => credentials.get(`${service}:${account}`) ?? null;
    keytar.setPassword = async (service, account, password) => { credentials.set(`${service}:${account}`, password); };
    keytar.deletePassword = async (service, account) => credentials.delete(`${service}:${account}`);
  }, STORE_KEY);
}

/** The keytar account Fleet uses for this HOME's storage directory. */
function fleetAccount(home: string): string {
  return `tls-v1:${createHash('sha256').update(fleetDir(home)).digest('hex')}`;
}

/** Raw stored value of this HOME's Fleet identity in the isolated store, or null. */
export async function storedIdentity(app: ElectronApplication, home: string): Promise<string | null> {
  return app.evaluate((_electron, { storeKey, key }) => {
    const credentials = (globalThis as Record<string, unknown>)[storeKey];
    if (!(credentials instanceof Map)) throw new Error('Fleet keytar not isolated');
    const value: unknown = credentials.get(key);
    return typeof value === 'string' ? value : null;
  }, { storeKey: STORE_KEY, key: `${FLEET_SERVICE}:${fleetAccount(home)}` });
}

/** Seeds this HOME's Fleet identity entry in the isolated store with a raw value. */
export async function seedStoredIdentity(app: ElectronApplication, home: string, value: string): Promise<void> {
  await app.evaluate((_electron, { storeKey, key, raw }) => {
    const credentials = (globalThis as Record<string, unknown>)[storeKey];
    if (!(credentials instanceof Map)) throw new Error('Fleet keytar not isolated');
    credentials.set(key, raw);
    if (credentials.get(key) !== raw) throw new Error('Seeded Fleet identity did not persist in the isolated store');
  }, { storeKey: STORE_KEY, key: `${FLEET_SERVICE}:${fleetAccount(home)}`, raw: value });
}

/** A valid identity in the shape the app stores: self-signed P-256 cert + matching PKCS#8 key, both PEM. */
export async function generateFleetIdentity(): Promise<{ cert: string; key: string; id: string }> {
  const keys = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const cert = (await X509CertificateGenerator.createSelfSigned({
    name: 'CN=MetaLogix IDE Fleet',
    keys,
    serialNumber: randomBytes(16).toString('hex'),
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 365 * 86400_000),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
  }, globalThis.crypto)).toString('pem');
  const key = createPrivateKey({
    key: Buffer.from(await globalThis.crypto.subtle.exportKey('pkcs8', keys.privateKey)),
    format: 'der',
    type: 'pkcs8',
  }).export({ format: 'pem', type: 'pkcs8' }).toString();
  const id = createHash('sha256').update(new X509Certificate(cert).raw).digest('hex');
  // Self-check: the seed is only meaningful if it is a usable, multi-line PEM pair.
  if (!cert.includes('\n') || !key.includes('\n')) throw new Error('Generated Fleet identity PEM has no newlines; legacy mangling would be a no-op');
  if (!new X509Certificate(cert).checkPrivateKey(createPrivateKey(key))) throw new Error('Generated Fleet identity key does not match its certificate');
  return { cert, key, id };
}

/** A free loopback TCP port, so parallel workers never contend for Fleet's default port. */
export async function reserveFleetPort(): Promise<number> {
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

/** A random 64-hex fingerprint for a seeded, never-reachable trusted peer. */
export function fakeFingerprint(): string {
  return randomBytes(32).toString('hex');
}
