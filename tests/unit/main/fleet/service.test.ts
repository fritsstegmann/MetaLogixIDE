import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Socket as DatagramSocket } from 'node:dgram';
import { Server as TlsServer } from 'node:tls';
import { join } from 'node:path';
import { FleetService, type FleetOperations } from '@main/fleet/service';
import { FleetDiscovery } from '@main/fleet/discovery';
import type { FleetKeychain } from '@main/fleet/identity';

const roots: string[] = [];
const vault = new Map<string, string>();
const keychain: FleetKeychain = {
  getPassword: async (service, account) => vault.get(`${service}:${account}`) ?? null,
  setPassword: async (service, account, password) => {
    vault.set(`${service}:${account}`, password);
  },
};
const operations = (): FleetOperations => ({
  status: () => ({ projects: [{ id: 1, name: 'Project' }], shells: [] }),
  launch: async () => ({ shellIndex: 0 }),
  stop: async () => {},
  write: async () => {},
  snapshot: async () => ({ output: 'safe', alive: true }),
});
function service(name: string) {
  const storageDir = mkdtempSync(join(tmpdir(), 'fleet-service-'));
  roots.push(storageDir);
  return new FleetService({ name, storageDir, operations: operations(), keychain });
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  vault.clear();
});

describe('fleet authorization', () => {
  it('defaults disabled and forbids unknown, revoked and offline status and shell operations', async () => {
    const fleet = service('Local');
    await fleet.start();
    expect(fleet.state()).toEqual({ enabled: false, peers: [] });
    await expect(fleet.status('a'.repeat(64))).rejects.toThrow();
    await expect(fleet.launch('a'.repeat(64), 1)).rejects.toThrow();
    await expect(fleet.stopShell('a'.repeat(64), 1, 0)).rejects.toThrow();
    await expect(fleet.write('a'.repeat(64), 1, 0, 'id\r')).rejects.toThrow();
    await expect(fleet.snapshot('a'.repeat(64), 1, 0)).rejects.toThrow();
    await fleet.stop();
  });

  it('refuses unsolicited pairing approval and never grants trust from a guessed code', async () => {
    const fleet = service('Local');
    await fleet.start();
    await expect(fleet.approve('a'.repeat(64), '0000-0000-0000')).rejects.toThrow();
    expect(fleet.state().peers).toEqual([]);
    await fleet.stop();
  });

  it('notifies subscribers when opt-in state changes', async () => {
    const first = service('Local');
    await first.start();
    const states: boolean[] = [];
    const unsubscribe = first.onChanged((state) => {
      states.push(state.enabled);
    });
    expect((await first.setEnabled(true)).enabled).toBe(true);
    unsubscribe();
    expect((await first.setEnabled(false)).enabled).toBe(false);
    expect(states).toEqual([true]);
    await first.stop();
  });

  it('persists revocation and refuses future pairing with that fingerprint', async () => {
    const first = service('Local');
    const dir = roots[roots.length - 1];
    if (!dir) throw new Error('Missing fixture directory');
    await first.start();
    const peerId = 'b'.repeat(64);
    await first.revoke(peerId);
    await first.stop();
    const restarted = new FleetService({
      name: 'Local',
      storageDir: dir,
      operations: operations(),
      keychain,
    });
    await restarted.start();
    await expect(restarted.pair(peerId)).rejects.toThrow('Peer not available for pairing');
    await expect(restarted.status(peerId)).rejects.toThrow();
    await restarted.stop();
  });

  it('does not stay enabled when the credential store fails', async () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'fleet-keychain-failure-'));
    roots.push(storageDir);
    const broken: FleetKeychain = {
      getPassword: async () => {
        throw new Error('unavailable');
      },
      setPassword: async () => {
        throw new Error('unavailable');
      },
    };
    const fleet = new FleetService({
      name: 'Local',
      storageDir,
      operations: operations(),
      keychain: broken,
    });
    await fleet.start();
    await expect(fleet.setEnabled(true)).rejects.toThrow('unavailable');
    expect(fleet.state().enabled).toBe(false);
    await fleet.stop();
  });
  it('keeps the app available when an enabled fleet cannot restore its credential', async () => {
    const initial = service('Local');
    const storageDir = roots[roots.length - 1];
    if (!storageDir) throw new Error('Missing fixture directory');
    await initial.start();
    await initial.setEnabled(true);
    await initial.stop();
    const broken: FleetKeychain = {
      getPassword: async () => {
        throw new Error('unavailable');
      },
      setPassword: async () => {
        throw new Error('unavailable');
      },
    };
    const restarted = new FleetService({
      name: 'Local',
      storageDir,
      operations: operations(),
      keychain: broken,
    });
    await restarted.start();
    expect(restarted.state().error).toMatch(/network unavailable/i);
    expect(Reflect.get(restarted, 'server')).toBeNull();
    await restarted.stop();
  });

  it('reports a listener failure instead of leaving an enabled fleet silently offline', async () => {
    const fleet = service('Local');
    await fleet.start();
    await fleet.setEnabled(true);
    const server: unknown = Reflect.get(fleet, 'server');
    if (!(server instanceof TlsServer)) throw new Error('Fleet listener did not start');
    server.emit('error', new Error('socket failure'));
    await vi.waitFor(() => {
      expect(fleet.state().error).toMatch(/network unavailable/i);
      expect(fleet.state().peers).toEqual([]);
    });
    await fleet.stop();
  });
  it('reports a multicast socket failure rather than silently losing discovery', async () => {
    const fleet = service('Local');
    await fleet.start();
    await fleet.setEnabled(true);
    const discovery: unknown = Reflect.get(fleet, 'discovery');
    if (!(discovery instanceof FleetDiscovery))
      throw new Error('Multicast discovery did not start');
    const socket: unknown = Reflect.get(discovery, 'socket');
    if (!(socket instanceof DatagramSocket)) throw new Error('Multicast socket did not start');
    socket.emit('error', new Error('multicast failed'));
    await vi.waitFor(() => {
      expect(fleet.state().error).toMatch(/network unavailable/i);
      expect(fleet.state().peers).toEqual([]);
    });
    await fleet.stop();
  });
});
