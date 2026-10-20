import { afterEach, describe, expect, it, vi } from 'vitest';
import { Duplex } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Socket as DatagramSocket } from 'node:dgram';
import { Server as TlsServer } from 'node:tls';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
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
  deletePassword: async (service, account) => vault.delete(`${service}:${account}`),
};
const operations = (): FleetOperations => ({
  status: () => ({ projects: [{ id: 1, name: 'Project' }], shells: [] }),
  launch: async () => ({ shellIndex: 0 }),
  stop: async () => {},
  write: async () => {},
  snapshot: async () => ({ output: 'safe', alive: true }),
});
function service(name: string, callbacks: FleetOperations = operations()) {
  const storageDir = mkdtempSync(join(tmpdir(), 'fleet-service-'));
  roots.push(storageDir);
  return new FleetService({ name, storageDir, operations: callbacks, keychain });
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
    expect(fleet.state()).toEqual({ enabled: false, peers: [], port: 0 });
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
    expect(restarted.state()).toEqual({ enabled: false, peers: [], port: 0 });
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
    expect(restarted.state()).toEqual({ enabled: false, peers: [], port: 0 });
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
      deletePassword: async () => {
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
      deletePassword: async () => {
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
  it.each(['saved', 'failed'] as const)(
    'does not replace an unapproved session with a preferred channel while trust persistence is %s',
    async (saveResult) => {
      const callbacks = operations();
      const status = vi.spyOn(callbacks, 'status');
      const fleet = service('Local', callbacks);
      await fleet.start();
      await fleet.setEnabled(true);
      const identity: unknown = Reflect.get(fleet, 'identity');
      if (
        !identity ||
        typeof identity !== 'object' ||
        !('id' in identity) ||
        typeof identity.id !== 'string'
      )
        throw new Error('Local identity unavailable');
      const peerId = identity.id === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
      Reflect.set(fleet, 'presence', [
        { id: peerId, name: 'Crossed peer', host: '127.0.0.1', port: 1, seen: Date.now() },
      ]);
      Reflect.set(fleet, 'certificate', () => peerId);
      const accept: unknown = Reflect.get(fleet, 'accept');
      const sessions: unknown = Reflect.get(fleet, 'sessions');
      const store: unknown = Reflect.get(fleet, 'store');
      if (
        typeof accept !== 'function' ||
        !(sessions instanceof Map) ||
        !(store instanceof FleetIdentityStore)
      )
        throw new Error('Fleet channel seam unavailable');
      const originalSave = store.save.bind(store);
      let enteredSave = () => {};
      const saving = new Promise<void>((resolve) => {
        enteredSave = resolve;
      });
      let releaseSave = () => {};
      let rejectSave: (error: Error) => void = () => {};
      const deferred = new Promise<void>((resolve, reject) => {
        releaseSave = resolve;
        rejectSave = reject;
      });
      const saveSpy = vi.spyOn(store, 'save').mockImplementationOnce(async (trust) => {
        enteredSave();
        await deferred;
        await originalSave(trust);
      });
      const socket = (onHello: (id: string, nonce: string) => void) => {
        const stream = new Duplex({
          read() {},
          write(chunk, _encoding, done) {
            const message = JSON.parse(chunk.toString()) as unknown;
            if (
              message &&
              typeof message === 'object' &&
              'type' in message &&
              message.type === 'hello' &&
              'id' in message &&
              typeof message.id === 'string' &&
              'nonce' in message &&
              typeof message.nonce === 'string'
            )
              onHello(message.id, message.nonce);
            done();
          },
        });
        Reflect.set(stream, 'setKeepAlive', () => stream);
        return stream;
      };
      let firstHelloId = '';
      let firstNonce = '';
      const first = socket((id, nonce) => {
        firstHelloId = id;
        firstNonce = nonce;
      });
      const preferred = socket(() => {});
      let approval: Promise<void> | undefined;
      let saveReleased = false;
      try {
        expect(accept.call(fleet, first, peerId)).toBe(true);
        const originalSession = sessions.get(peerId);
        expect(originalSession).toBeDefined();
        expect(firstHelloId).toMatch(/^[a-f0-9]{32}$/);
        expect(firstNonce).toMatch(/^[a-f0-9]{64}$/);
        const frame = (message: object) => {
          first.push(Buffer.from(`${JSON.stringify(message)}\n`));
        };
        frame({ type: 'hello', id: 'a'.repeat(32), nonce: 'b'.repeat(64) });
        await vi.waitFor(() =>
          expect(fleet.state().peers.find((peer) => peer.id === peerId)?.status).toBe('pending'),
        );
        const code = fleet.state().peers.find((peer) => peer.id === peerId)?.verificationCode;
        if (!code) throw new Error('Pending comparison code unavailable');
        frame({ type: 'approve', id: 'a'.repeat(32), nonce: firstNonce });
        await vi.waitFor(() => {
          const pending: unknown = sessions.get(peerId);
          expect(pending).toHaveProperty('approvedRemote', true);
        });
        approval = fleet.approve(peerId, code);
        void approval.catch(() => {});
        await saving;
        expect(fleet.state().peers.find((peer) => peer.id === peerId)?.status).toBe('pending');
        expect((await store.load()).trusted).toEqual([]);
        accept.call(fleet, preferred);
        expect.soft(preferred.destroyed).toBe(true);
        if (!preferred.destroyed) {
          preferred.push(
            Buffer.from(
              `${JSON.stringify({ type: 'hello', id: 'c'.repeat(32), nonce: 'd'.repeat(64) })}\n`,
            ),
          );
          preferred.push(
            Buffer.from(
              `${JSON.stringify({
                type: 'request',
                id: 'e'.repeat(32),
                op: 'status',
                args: { projectOffset: 0, shellOffset: 0 },
              })}\n`,
            ),
          );
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect.soft(first.destroyed).toBe(false);
        expect.soft(sessions.get(peerId)).toBe(originalSession);
        expect.soft(fleet.state().peers.find((peer) => peer.id === peerId)).toMatchObject({
          status: 'pending',
          verificationCode: code,
        });
        expect.soft(status).not.toHaveBeenCalled();
        if (saveResult === 'failed') {
          frame({
            type: 'request',
            id: '0'.repeat(32),
            op: 'status',
            args: { projectOffset: 0, shellOffset: 0 },
          });
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(status).not.toHaveBeenCalled();
          rejectSave(new Error('disk full'));
          saveReleased = true;
          await expect(approval).rejects.toThrow('disk full');
          expect(sessions.has(peerId)).toBe(false);
          expect(preferred.destroyed).toBe(true);
          expect(fleet.state().peers.find((peer) => peer.id === peerId)?.status).toBe('discovered');
          await expect(fleet.status(peerId)).rejects.toThrow('Peer is not linked and online');
          expect((await store.load()).trusted).toEqual([]);
          expect(status).not.toHaveBeenCalled();
        } else {
          releaseSave();
          saveReleased = true;
          await approval;
          expect(fleet.state().peers.find((peer) => peer.id === peerId)?.status).toBe('linked');
          expect(sessions.get(peerId)).toBe(originalSession);
          frame({
            type: 'request',
            id: 'f'.repeat(32),
            op: 'status',
            args: { projectOffset: 0, shellOffset: 0 },
          });
          await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1));
        }
      } finally {
        if (!saveReleased) releaseSave();
        await approval?.catch(() => {});
        saveSpy.mockRestore();
        await fleet.stop();
      }
    },
  );
});

async function occupy(port = 0): Promise<{ server: TcpServer; port: number }> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return { server, port: address.port };
}
async function freePort(): Promise<number> {
  const held = await occupy();
  await new Promise((resolve) => held.server.close(resolve));
  return held.port;
}
function portedService(getPort: () => number, savePort: (port: number) => void = () => {}) {
  const storageDir = mkdtempSync(join(tmpdir(), 'fleet-port-'));
  roots.push(storageDir);
  const fleet = new FleetService({
    name: 'Local',
    storageDir,
    operations: operations(),
    keychain,
    getPort,
    savePort,
  });
  return { fleet, storageDir };
}
function boundPort(fleet: FleetService): number | undefined {
  const server: unknown = Reflect.get(fleet, 'server');
  const address = server instanceof TlsServer ? server.address() : null;
  return address && typeof address !== 'string' ? address.port : undefined;
}

describe('fleet listener port', () => {
  it('binds the configured port and reports it in state', async () => {
    const port = await freePort();
    const { fleet } = portedService(() => port);
    await fleet.start();
    await fleet.setEnabled(true);
    try {
      expect(boundPort(fleet)).toBe(port);
      expect(fleet.state().port).toBe(port);
    } finally {
      await fleet.stop();
    }
  });

  it('fails enable with the exact in-use message, stays disabled and surfaces it in state', async () => {
    const held = await occupy();
    const { fleet, storageDir } = portedService(() => held.port);
    await fleet.start();
    try {
      const message = `Fleet port ${held.port} is already in use`;
      await expect(fleet.setEnabled(true)).rejects.toThrow(new RegExp(`^${message}$`));
      expect(fleet.state().enabled).toBe(false);
      expect(fleet.state().error).toBe(message);
      expect((await new FleetIdentityStore(storageDir, keychain).load()).enabled).toBe(false);
      expect(boundPort(fleet)).toBeUndefined();
    } finally {
      await fleet.stop();
      await new Promise((resolve) => held.server.close(resolve));
    }
  });

  it('reports the in-use message when a saved opt-in cannot bind at start', async () => {
    const port = await freePort();
    const first = portedService(() => port);
    await first.fleet.start();
    await first.fleet.setEnabled(true);
    await first.fleet.stop();
    const held = await occupy(port);
    const second = new FleetService({
      name: 'Local',
      storageDir: first.storageDir,
      operations: operations(),
      keychain,
      getPort: () => port,
    });
    try {
      await second.start();
      expect(second.state().error).toBe(`Fleet port ${port} is already in use`);
    } finally {
      await second.stop();
      await new Promise((resolve) => held.server.close(resolve));
    }
  });

  it('rejects every hostile port value without persisting or rebinding', async () => {
    const port = await freePort();
    const saved: number[] = [];
    const { fleet } = portedService(
      () => port,
      (value) => saved.push(value),
    );
    await fleet.start();
    await fleet.setEnabled(true);
    try {
      const hostile: unknown[] = [
        undefined,
        null,
        '43872',
        '',
        {},
        [],
        [43872],
        43872.5,
        Number.NaN,
        Infinity,
        -Infinity,
        1023,
        0,
        -1,
        65536,
        2 ** 32,
        true,
        1n,
      ];
      for (const value of hostile)
        await expect(fleet.setPort(value), String(value)).rejects.toThrow(
          'Fleet port must be an integer between 1024 and 65535',
        );
      expect(saved).toEqual([]);
      expect(boundPort(fleet)).toBe(port);
    } finally {
      await fleet.stop();
    }
  });

  it('accepts the 1024 and 65535 bounds as valid input', async () => {
    const saved: number[] = [];
    const { fleet } = portedService(
      () => 0,
      (value) => saved.push(value),
    );
    await fleet.start();
    await fleet.setPort(1024);
    await fleet.setPort(65535);
    expect(saved).toEqual([1024, 65535]);
  });

  it('persists the new port and re-binds a running listener on it', async () => {
    const first = await freePort();
    const second = await freePort();
    let current = first;
    const saved: number[] = [];
    const { fleet } = portedService(
      () => current,
      (value) => {
        saved.push(value);
        current = value;
      },
    );
    await fleet.start();
    await fleet.setEnabled(true);
    try {
      const state = await fleet.setPort(second);
      expect(saved).toEqual([second]);
      expect(boundPort(fleet)).toBe(second);
      expect(state.port).toBe(second);
      expect(state.enabled).toBe(true);
    } finally {
      await fleet.stop();
    }
  });

  it('only persists when fleet is disabled and does not open a listener', async () => {
    const next = await freePort();
    let current = 43872;
    const { fleet } = portedService(
      () => current,
      (value) => {
        current = value;
      },
    );
    await fleet.start();
    const state = await fleet.setPort(next);
    expect(state).toMatchObject({ enabled: false, port: next });
    expect(boundPort(fleet)).toBeUndefined();
  });

  it('rolls the port back and keeps listening on the old one when the new port is taken', async () => {
    const first = await freePort();
    const held = await occupy();
    let current = first;
    const saved: number[] = [];
    const { fleet } = portedService(
      () => current,
      (value) => {
        saved.push(value);
        current = value;
      },
    );
    await fleet.start();
    await fleet.setEnabled(true);
    try {
      await expect(fleet.setPort(held.port)).rejects.toThrow(
        `Fleet port ${held.port} is already in use`,
      );
      expect(current).toBe(first);
      expect(saved).toEqual([held.port, first]);
      expect(boundPort(fleet)).toBe(first);
      expect(fleet.state().enabled).toBe(true);
    } finally {
      await fleet.stop();
      await new Promise((resolve) => held.server.close(resolve));
    }
  });
});

describe('fleet identity recovery', () => {
  async function corrupted() {
    const { fleet, storageDir } = portedService(() => 0);
    await fleet.start();
    await new FleetIdentityStore(storageDir, keychain).loadIdentity();
    const [account] = [...vault.keys()];
    if (!account) throw new Error('Missing credential');
    vault.set(account, '{"cert":"x","key":"y"}');
    return { fleet, storageDir, account };
  }

  it('flags recovery with a specific message when the stored identity is unreadable', async () => {
    const { fleet } = await corrupted();
    await expect(fleet.setEnabled(true)).rejects.toThrow();
    const state = fleet.state();
    expect(state.recovery).toBe('reset-identity');
    expect(state.enabled).toBe(false);
    expect(state.error).toBe(
      'Fleet identity in the credential store is unreadable. Reset identity to create a new one; paired devices must pair again.',
    );
    await fleet.stop();
  });

  it('flags recovery when a saved opt-in cannot load its identity at start', async () => {
    const { fleet, storageDir } = portedService(() => 0);
    await fleet.start();
    await fleet.setEnabled(true);
    await fleet.stop();
    const [account] = [...vault.keys()];
    if (!account) throw new Error('Missing credential');
    vault.set(account, 'garbage');
    const restarted = new FleetService({
      name: 'Local',
      storageDir,
      operations: operations(),
      keychain,
      getPort: () => 0,
    });
    await restarted.start();
    expect(restarted.state().recovery).toBe('reset-identity');
    await restarted.stop();
  });

  it('does not flag recovery for a keychain outage or an in-use port', async () => {
    const held = await occupy();
    const busy = portedService(() => held.port);
    await busy.fleet.start();
    await expect(busy.fleet.setEnabled(true)).rejects.toThrow();
    expect(busy.fleet.state().recovery).toBeUndefined();
    await new Promise((resolve) => held.server.close(resolve));
    const down: FleetKeychain = {
      ...keychain,
      getPassword: async () => Promise.reject(new Error('down')),
    };
    const storageDir = mkdtempSync(join(tmpdir(), 'fleet-outage-'));
    roots.push(storageDir);
    const outage = new FleetService({
      name: 'L',
      storageDir,
      operations: operations(),
      keychain: down,
    });
    await outage.start();
    await expect(outage.setEnabled(true)).rejects.toThrow('down');
    expect(outage.state().recovery).toBeUndefined();
    expect(outage.state().error).not.toMatch(/unreadable/);
  });

  it('refuses reset on a working identity and deletes nothing', async () => {
    const { fleet } = portedService(() => 0);
    await fleet.start();
    await fleet.setEnabled(true);
    const before = new Map(vault);
    await expect(fleet.resetIdentity()).rejects.toThrow('Fleet identity reset is not available');
    expect(new Map(vault)).toEqual(before);
    expect(fleet.state().enabled).toBe(true);
    await fleet.stop();
  });

  it('refuses reset on a fresh service with no identity at all', async () => {
    const { fleet } = portedService(() => 0);
    await fleet.start();
    await expect(fleet.resetIdentity()).rejects.toThrow('Fleet identity reset is not available');
    expect(vault.size).toBe(0);
  });

  it('resets: new identity, trusted cleared, revoked preserved, disabled, recovery cleared', async () => {
    const { fleet, storageDir, account } = await corrupted();
    const store = new FleetIdentityStore(storageDir, keychain);
    const revoked = 'b'.repeat(64);
    await store.save({
      enabled: true,
      trusted: [{ id: 'a'.repeat(64), name: 'Peer' }],
      revoked: [revoked],
    });
    const restarted = new FleetService({
      name: 'Local',
      storageDir,
      operations: operations(),
      keychain,
      getPort: () => 0,
    });
    await restarted.start();
    expect(restarted.state().recovery).toBe('reset-identity');
    const state = await restarted.resetIdentity();
    expect(state.recovery).toBeUndefined();
    expect(state.error).toBeUndefined();
    expect(state.enabled).toBe(false);
    expect(state.peers).toEqual([]);
    expect(await store.load()).toEqual({ enabled: false, trusted: [], revoked: [revoked] });
    expect(vault.get(account)).not.toBe('{"cert":"x","key":"y"}');
    await expect(store.loadIdentity(true)).resolves.toMatchObject({ id: expect.any(String) });
    await expect(restarted.setEnabled(true)).resolves.toMatchObject({ enabled: true });
    await restarted.stop();
    await fleet.stop();
  });

  it('refuses a second reset once recovered', async () => {
    const { fleet } = await corrupted();
    await expect(fleet.setEnabled(true)).rejects.toThrow();
    await fleet.resetIdentity();
    const after = new Map(vault);
    await expect(fleet.resetIdentity()).rejects.toThrow('Fleet identity reset is not available');
    expect(new Map(vault)).toEqual(after);
    await fleet.stop();
  });
});
