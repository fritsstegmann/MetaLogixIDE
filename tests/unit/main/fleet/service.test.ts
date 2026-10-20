import { afterEach, describe, expect, it, vi } from 'vitest';
import { Duplex } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Socket as DatagramSocket } from 'node:dgram';
import { Server as TlsServer } from 'node:tls';
import { join } from 'node:path';
import { FleetService, type FleetOperations } from '@main/fleet/service';
import { FleetChannel } from '@main/fleet/channel';
import { FleetDiscovery } from '@main/fleet/discovery';
import { FleetIdentityStore, type FleetKeychain } from '@main/fleet/identity';
import { STATUS_PAGE_SIZE } from '@main/fleet/protocol';

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

function linkedChannel(fleet: FleetService, peerId: string): FleetChannel {
  Reflect.set(fleet, 'trust', {
    enabled: true,
    trusted: [{ id: peerId, name: 'Peer' }],
    revoked: [],
  });
  const sessions: unknown = Reflect.get(fleet, 'sessions');
  if (!(sessions instanceof Map)) throw new Error('Session map unavailable');
  const channel = new FleetChannel(
    new Duplex({
      read() {},
      write(_chunk, _encoding, done) {
        done();
      },
    }),
  );
  sessions.set(peerId, { id: peerId, channel, remoteNonce: 'f'.repeat(64) });
  return channel;
}

describe('fleet authorization', () => {
  it('rejects invalid machine identity and remote actions before fleet startup', async () => {
    expect(() => service('   ')).toThrow('Invalid fleet machine name');
    expect(() => service('x'.repeat(81))).toThrow('Invalid fleet machine name');
    const fleet = service('Local');
    await expect(fleet.setEnabled(true)).rejects.toThrow('Fleet service not started');
    expect(fleet.state().enabled).toBe(false);
  });

  it('closes an established channel before persisting peer revocation', async () => {
    const fleet = service('Local');
    const peerId = 'e'.repeat(64);
    await fleet.start();
    const channel = linkedChannel(fleet, peerId);
    const request = vi.spyOn(channel, 'request');
    await expect(fleet.write(peerId, 1, 0, '')).rejects.toThrow('Invalid shell input');
    await expect(fleet.write(peerId, 1, 0, 'x'.repeat(8193))).rejects.toThrow(
      'Invalid shell input',
    );
    expect(request).not.toHaveBeenCalled();
    await fleet.revoke(peerId);
    expect(channel.socket.destroyed).toBe(true);
    await expect(fleet.status(peerId)).rejects.toThrow('Peer is not linked and online');
    await expect(fleet.pair(peerId)).rejects.toThrow('Peer not available for pairing');
    await fleet.stop();
  });

  it('rejects malformed remote results and invalid shell identifiers at the trusted boundary', async () => {
    const fleet = service('Local');
    const peerId = 'f'.repeat(64);
    const channel = linkedChannel(fleet, peerId);
    const request = vi.spyOn(channel, 'request');
    await expect(fleet.launch(peerId, 0)).rejects.toThrow('Invalid project ID');
    await expect(fleet.stopShell(peerId, 1, -1)).rejects.toThrow('Invalid shell identity');
    await expect(fleet.snapshot(peerId, 0, 0)).rejects.toThrow('Invalid shell identity');
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce({ shellIndex: -1 });
    await expect(fleet.launch(peerId, 1)).rejects.toThrow('Invalid peer shell');
    request.mockResolvedValueOnce({ output: 'x'.repeat(8193), alive: true });
    await expect(fleet.snapshot(peerId, 1, 0)).rejects.toThrow('Invalid peer output');
    expect(request).toHaveBeenCalledTimes(2);
    channel.close();
  });

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
    await fleet.setEnabled(true);
    await expect(fleet.pair('a'.repeat(64))).rejects.toThrow('Peer not discovered');
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

  it('keeps a disabled listener closed when credential loading completes after disable', async () => {
    const fleet = service('Local');
    await fleet.start();
    const store: unknown = Reflect.get(fleet, 'store');
    if (!(store instanceof FleetIdentityStore)) throw new Error('Fleet trust store unavailable');
    const load = store.loadIdentity.bind(store);
    let release!: () => void;
    let loading!: () => void;
    const entered = new Promise<void>((resolve) => {
      loading = resolve;
    });
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(store, 'loadIdentity').mockImplementationOnce(async (requireExisting) => {
      loading();
      await deferred;
      return load(requireExisting);
    });
    try {
      const enabling = fleet.setEnabled(true);
      await entered;
      const disabling = fleet.setEnabled(false);
      let disabled = false;
      void disabling.then(() => {
        disabled = true;
      });
      await Promise.resolve();
      expect(disabled).toBe(false);
      release();
      await enabling;
      expect((await disabling).enabled).toBe(false);
      expect(Reflect.get(fleet, 'server')).toBeNull();
      expect(Reflect.get(fleet, 'discovery')).toBeNull();
      expect(fleet.state().enabled).toBe(false);
      expect((await store.load()).enabled).toBe(false);
    } finally {
      release();
      spy.mockRestore();
      await fleet.stop();
    }
  });

  it('does not reopen after stop while a saved opt-in loads credentials', async () => {
    const fleet = service('Local');
    await fleet.start();
    await fleet.setEnabled(true);
    await fleet.stop();
    const store: unknown = Reflect.get(fleet, 'store');
    if (!(store instanceof FleetIdentityStore)) throw new Error('Fleet trust store unavailable');
    const load = store.loadIdentity.bind(store);
    let release!: () => void;
    let loading!: () => void;
    const entered = new Promise<void>((resolve) => {
      loading = resolve;
    });
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(store, 'loadIdentity').mockImplementationOnce(async (requireExisting) => {
      loading();
      await deferred;
      return load(requireExisting);
    });
    try {
      const starting = fleet.start();
      await entered;
      const stopping = fleet.stop();
      release();
      await starting;
      await stopping;
      expect(Reflect.get(fleet, 'server')).toBeNull();
      expect(Reflect.get(fleet, 'discovery')).toBeNull();
      expect(fleet.state().enabled).toBe(false);
    } finally {
      release();
      spy.mockRestore();
      await fleet.stop();
    }
  });

  it('keeps opt-out durable when a pending enable fails credential loading', async () => {
    const fleet = service('Local');
    await fleet.start();
    const store: unknown = Reflect.get(fleet, 'store');
    if (!(store instanceof FleetIdentityStore)) throw new Error('Fleet trust store unavailable');
    let release!: () => void;
    let loading!: () => void;
    const entered = new Promise<void>((resolve) => {
      loading = resolve;
    });
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(store, 'loadIdentity').mockImplementationOnce(async () => {
      loading();
      await deferred;
      throw new Error('credential denied');
    });
    try {
      const enabling = fleet.setEnabled(true);
      void enabling.catch(() => {});
      await entered;
      const disabling = fleet.setEnabled(false);
      release();
      await expect(enabling).rejects.toThrow('credential denied');
      expect((await disabling).enabled).toBe(false);
      expect((await store.load()).enabled).toBe(false);
      expect(Reflect.get(fleet, 'server')).toBeNull();
      expect(Reflect.get(fleet, 'discovery')).toBeNull();
    } finally {
      release();
      spy.mockRestore();
      await fleet.stop();
    }
  });

  it('preserves previously linked peers when enabling fails before networking', async () => {
    const fleet = service('Local');
    await fleet.start();
    const store: unknown = Reflect.get(fleet, 'store');
    if (!(store instanceof FleetIdentityStore)) throw new Error('Fleet trust store unavailable');
    await store.loadIdentity();
    const trusted = [{ id: 'b'.repeat(64), name: 'Existing peer' }];
    await store.save({ enabled: false, trusted, revoked: [] });
    await fleet.stop();
    await fleet.start();
    const spy = vi
      .spyOn(store, 'loadIdentity')
      .mockRejectedValueOnce(new Error('credential denied'));
    try {
      await expect(fleet.setEnabled(true)).rejects.toThrow('credential denied');
      expect(await store.load()).toEqual({ enabled: false, trusted, revoked: [] });
      expect(fleet.state().peers).toEqual([
        { id: trusted[0]!.id, name: 'Existing peer', status: 'offline' },
      ]);
      expect(Reflect.get(fleet, 'server')).toBeNull();
    } finally {
      spy.mockRestore();
      await fleet.stop();
    }
  });

  it('revokes a linked 257th fingerprint without losing earlier revocations on restart', async () => {
    const fleet = service('Local');
    const storageDir = roots[roots.length - 1];
    if (!storageDir) throw new Error('Missing fixture directory');
    await fleet.start();
    const earlier = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(64, '0'));
    const peerId = 'f'.repeat(64);
    const store = new FleetIdentityStore(storageDir, keychain);
    await store.loadIdentity();
    await store.save({
      enabled: true,
      trusted: [{ id: peerId, name: 'Peer' }],
      revoked: earlier,
    });
    const channel = linkedChannel(fleet, peerId);
    Reflect.set(fleet, 'trust', {
      enabled: true,
      trusted: [{ id: peerId, name: 'Peer' }],
      revoked: earlier,
    });
    await fleet.revoke(peerId);
    expect(channel.socket.destroyed).toBe(true);
    expect((await store.load()).revoked).toEqual([...earlier, peerId]);
    expect((await store.load()).trusted).toEqual([]);
    await expect(fleet.pair(peerId)).rejects.toThrow('Peer not available for pairing');
    await fleet.stop();
    const restarted = new FleetService({
      name: 'Local',
      storageDir,
      operations: operations(),
      keychain,
    });
    await restarted.start();
    expect(restarted.state().error).toBeUndefined();
    await expect(restarted.pair(peerId)).rejects.toThrow('Peer not available for pairing');
    expect((await store.load()).revoked).toEqual([...earlier, peerId]);
    await restarted.stop();
  });

  it('keeps a revoked peer denied and clears saved trust when persistence fails', async () => {
    const fleet = service('Local');
    const storageDir = roots[roots.length - 1];
    if (!storageDir) throw new Error('Missing fixture directory');
    await fleet.start();
    const peerId = 'e'.repeat(64);
    const otherId = 'c'.repeat(64);
    const store: unknown = Reflect.get(fleet, 'store');
    if (!(store instanceof FleetIdentityStore)) throw new Error('Fleet trust store unavailable');
    const trusted = [
      { id: peerId, name: 'Peer' },
      { id: otherId, name: 'Other' },
    ];
    await store.save({ enabled: true, trusted, revoked: [] });
    const channel = linkedChannel(fleet, peerId);
    const otherChannel = linkedChannel(fleet, otherId);
    Reflect.set(fleet, 'trust', { enabled: true, trusted, revoked: [] });
    const spy = vi.spyOn(store, 'save').mockImplementationOnce(async () => {
      throw new Error('disk full');
    });
    try {
      await expect(fleet.revoke(peerId)).rejects.toThrow('disk full');
      expect(channel.socket.destroyed).toBe(true);
      expect(otherChannel.socket.destroyed).toBe(true);
      await expect(fleet.pair(peerId)).rejects.toThrow('Peer not available for pairing');
      expect((await store.load()).trusted).toEqual([]);
      expect((await store.load()).revoked).toEqual([peerId]);
      const persisted = readFileSync(join(storageDir, 'trust.json'), 'utf8');
      expect(persisted).not.toContain('"trusted":[{"id"');
    } finally {
      spy.mockRestore();
      await fleet.stop();
    }
    const restarted = new FleetService({
      name: 'Local',
      storageDir,
      operations: operations(),
      keychain,
    });
    await restarted.start();
    expect(restarted.state()).toEqual({ enabled: false, peers: [] });
    expect((await store.load()).revoked).toEqual([peerId]);
    await expect(restarted.pair(peerId)).rejects.toThrow('Peer not available for pairing');
    await restarted.stop();
  });

  it('invalidates stale trusted storage when both revocation writes fail', async () => {
    const fleet = service('Local');
    const storageDir = roots[roots.length - 1];
    if (!storageDir) throw new Error('Missing fixture directory');
    await fleet.start();
    const peerId = 'd'.repeat(64);
    const store: unknown = Reflect.get(fleet, 'store');
    if (!(store instanceof FleetIdentityStore)) throw new Error('Fleet trust store unavailable');
    await store.save({ enabled: true, trusted: [{ id: peerId, name: 'Peer' }], revoked: [] });
    const channel = linkedChannel(fleet, peerId);
    const spy = vi.spyOn(store, 'save').mockRejectedValue(new Error('disk full'));
    try {
      await expect(fleet.revoke(peerId)).rejects.toThrow('disk full');
      expect(channel.socket.destroyed).toBe(true);
      await expect(fleet.pair(peerId)).rejects.toThrow('Peer not available for pairing');
      expect(await store.load()).toEqual({ enabled: false, trusted: [], revoked: [] });
    } finally {
      spy.mockRestore();
      await fleet.stop();
    }
    const restarted = new FleetService({
      name: 'Local',
      storageDir,
      operations: operations(),
      keychain,
    });
    await restarted.start();
    expect(restarted.state()).toEqual({ enabled: false, peers: [] });
    await expect(restarted.pair(peerId)).rejects.toThrow('Peer not available for pairing');
    await restarted.stop();
  });

  it('fails closed when disabling cannot save the opt-out', async () => {
    const fleet = service('Local');
    await fleet.start();
    await fleet.setEnabled(true);
    const store: unknown = Reflect.get(fleet, 'store');
    if (!(store instanceof FleetIdentityStore)) throw new Error('Fleet trust store unavailable');
    const spy = vi.spyOn(store, 'save').mockRejectedValue(new Error('disk full'));
    try {
      await expect(fleet.setEnabled(false)).rejects.toThrow('disk full');
      expect(fleet.state().enabled).toBe(false);
      expect(Reflect.get(fleet, 'server')).toBeNull();
      expect(Reflect.get(fleet, 'discovery')).toBeNull();
      expect(await store.load()).toEqual({ enabled: false, trusted: [], revoked: [] });
    } finally {
      spy.mockRestore();
      await fleet.stop();
    }
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
  it('rejects malformed and inconsistent status pages instead of returning partial lists', async () => {
    const fleet = service('Local');
    const peerId = 'd'.repeat(64);
    const channel = linkedChannel(fleet, peerId);
    const request = vi.spyOn(channel, 'request');
    const first = {
      projects: Array.from({ length: STATUS_PAGE_SIZE }, (_, index) => ({
        id: index + 1,
        name: `Project ${index + 1}`,
      })),
      shells: [],
      projectOffset: 0,
      shellOffset: 0,
      projectTotal: STATUS_PAGE_SIZE + 1,
      shellTotal: 0,
      token: 'f'.repeat(32),
    };
    request.mockResolvedValueOnce({ ...first, projects: [] });
    await expect(fleet.status(peerId)).rejects.toThrow('Invalid peer status page');
    request.mockResolvedValueOnce(first).mockResolvedValueOnce({ ...first });
    await expect(fleet.status(peerId)).rejects.toThrow('Invalid peer status page');
    request.mockResolvedValueOnce(first).mockResolvedValueOnce({
      ...first,
      projectOffset: STATUS_PAGE_SIZE,
      projectTotal: STATUS_PAGE_SIZE + 2,
      projects: [
        { id: 13, name: 'Thirteen' },
        { id: 14, name: 'Fourteen' },
      ],
    });
    await expect(fleet.status(peerId)).rejects.toThrow('Invalid peer status page');
    request.mockResolvedValueOnce(first).mockResolvedValueOnce({
      ...first,
      projectOffset: STATUS_PAGE_SIZE,
      projects: [{ id: 13, name: 'Thirteen' }],
      token: 'e'.repeat(32),
    });
    await expect(fleet.status(peerId)).rejects.toThrow('Invalid peer status page');
    expect(request).toHaveBeenCalledTimes(7);
    channel.close();
  });
});
