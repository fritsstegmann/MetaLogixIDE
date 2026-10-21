import { afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Server as TlsServer, TLSSocket } from 'node:tls';
import { join } from 'node:path';
import { connect as connectTcp, type Socket } from 'node:net';
import type { FleetStatus } from '@shared/fleet-contract';
import { FleetService, type FleetOperations } from '@main/fleet/service';
import { FleetDiscovery } from '@main/fleet/discovery';
import { FleetIdentityStore } from '@main/fleet/identity';
import { FleetChannel } from '@main/fleet/channel';
import { validateStatusPage } from '@main/fleet/protocol';

const roots: string[] = [];
const secrets = new Map<string, string>();
const keychain = {
  async getPassword(service: string, account: string) {
    return secrets.get(`${service}:${account}`) ?? null;
  },
  async setPassword(service: string, account: string, password: string) {
    secrets.set(`${service}:${account}`, password);
  },
  async deletePassword(service: string, account: string) {
    return secrets.delete(`${service}:${account}`);
  },
};
const instances: FleetService[] = [];
afterAll(async () => {
  for (const instance of instances) await instance.stop();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function announceTo(receiver: FleetService, remote: FleetService, name: string) {
  const discovery: unknown = Reflect.get(receiver, 'discovery');
  const identity: unknown = Reflect.get(remote, 'identity');
  const server: unknown = Reflect.get(remote, 'server');
  if (
    !(discovery instanceof FleetDiscovery) ||
    !(server instanceof TlsServer) ||
    identity === null ||
    typeof identity !== 'object' ||
    !('id' in identity) ||
    typeof identity.id !== 'string'
  )
    throw new Error('Live fleet runtime unavailable');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Live fleet listener unavailable');
  discovery.observe(
    Buffer.from(JSON.stringify({ v: 1, id: identity.id, name, port: address.port })),
    '127.0.0.1',
  );
}

it('streams a remote Claude shell through one authenticated subscription and cancels on revoke', async () => {
  let output: ((data: string) => void) | undefined;
  let exit: (() => void) | undefined;
  const launchClaude = vi.fn(async () => ({ shellIndex: 0 }));
  const resize = vi.fn(async () => {});
  const remoteOps: FleetOperations = {
    status: () => ({ roots: [{ id: 3, name: 'Root' }], projects: [{ id: 7, rootId: 3, name: 'Remote' }],
      shells: [{ projectId: 7, shellIndex: 0, agent: 'claude', state: 'busy',
        launchName: 'Claude', pinned: false, startedAt: null, lastActiveAt: null }] }),
    launch: async () => ({ shellIndex: 1 }),
    launchClaude,
    profiles: async () => ({ profiles: [], defaultCliName: null }),
    launchCli: async () => ({ shellIndex: 1 }),
    setDefaultCli: async (_id, name) => ({ defaultCliName: name }),
    removeCliProfile: async () => ({ ok: true }),
    stop: async () => {},
    write: async () => {},
    resize,
    isAlive: (projectId, shellIndex) => projectId === 7 && shellIndex === 0,
    hasProject: (projectId) => projectId === 7,
    watch: (_projectId, _shellIndex, onData, onExit) => {
      output = onData;
      exit = onExit;
      return () => { output = undefined; exit = undefined; };
    },
    terminalSnapshot: async () => '\x1b[31m' + '🙂'.repeat(3000) + '\x1b[0m',
    snapshot: async () => ({ output: '', alive: true }),
  };
  const localOps: FleetOperations = {
    ...remoteOps,
    status: () => ({ roots: [], projects: [], shells: [] }),
    isAlive: () => false,
  };
  const instance = (name: string, operations: FleetOperations): FleetService => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-stream-'));
    roots.push(root);
    const fleet = new FleetService({ name, storageDir: join(root, 'fleet'), operations, keychain });
    instances.push(fleet);
    return fleet;
  };
  const a = instance('stream A', localOps);
  const b = instance('stream B', remoteOps);
  await a.start();
  await b.start();
  await a.setEnabled(true);
  await b.setEnabled(true);
  announceTo(a, b, 'stream B');
  announceTo(b, a, 'stream A');
  const peer = a.state().peers.find(({ name }) => name === 'stream B');
  const local = b.state().peers.find(({ name }) => name === 'stream A');
  if (!peer || !local) throw new Error('Discovery missing');
  await expect(a.subscribe(peer.id, 7, 0)).rejects.toThrow();
  await a.pair(peer.id);
  await vi.waitFor(() => expect(b.state().peers.find(({ id }) => id === local.id)?.verificationCode).toBeTruthy());
  const code = a.state().peers.find(({ id }) => id === peer.id)?.verificationCode;
  if (!code) throw new Error('Comparison code missing');
  await a.approve(peer.id, code);
  await b.approve(local.id, code);
  await vi.waitFor(() => expect(a.state().peers.find(({ id }) => id === peer.id)?.status).toBe('linked'));
  await expect(a.subscribe(peer.id, 8, 0)).rejects.toThrow();
  launchClaude.mockRejectedValueOnce(new Error('Choose a Claude permission mode first'));
  await expect(a.launchClaude(peer.id, 7)).rejects.toThrow('Choose a Claude permission mode on the remote machine first');
  launchClaude.mockRejectedValueOnce(new Error('shell failed to start: spawn claude ENOENT /private/secret'));
  await expect(a.launchClaude(peer.id, 7)).rejects.toThrow('Claude is unavailable on the remote machine');
  launchClaude.mockRejectedValueOnce(new Error('all shells are pinned — unpin one or raise cap'));
  await expect(a.launchClaude(peer.id, 7)).rejects.toThrow('Remote shell limit reached');
  launchClaude.mockRejectedValueOnce(new Error('Project folder no longer exists at /private/secret'));
  await expect(a.launchClaude(peer.id, 7)).rejects.toThrow('Remote project folder is unavailable');
  await expect(a.resize(peer.id, 7, 0, 501, 35)).rejects.toThrow('Invalid terminal dimensions');
  expect(await a.launchClaude(peer.id, 7)).toEqual({ shellIndex: 0 });
  expect(launchClaude).toHaveBeenCalledWith(7);
  await expect(a.resize(peer.id, 7, 0, 91, 35)).rejects.toThrow('Peer refused fleet operation');
  expect(resize).not.toHaveBeenCalled();
  const events: Array<{ subscriptionId: string; kind: string; data: string }> = [];
  a.onTerminal((event) => events.push(event));
  const { subscriptionId } = await a.subscribe(peer.id, 7, 0);
  expect(b.state().controls).toEqual([{ projectId: 7, shellIndex: 0, peerName: 'stream A' }]);
  await expect(a.subscribe(peer.id, 7, 0)).rejects.toThrow('Peer refused fleet operation');
  expect(b.state().controls).toHaveLength(1);
  output?.('\x1b[36mduring-snapshot\x1b[0m');
  await vi.waitFor(() => expect(events.some((event) => event.kind === 'ready')).toBe(true));
  expect(events.filter((event) => event.kind === 'snapshot').map((event) => event.data).join('')).toBe('\x1b[31m' + '🙂'.repeat(3000) + '\x1b[0m');
  expect(events.every((event) => event.subscriptionId === subscriptionId)).toBe(true);
  const remoteSessions: unknown = Reflect.get(b, 'sessions');
  if (!(remoteSessions instanceof Map)) throw new Error('Remote sessions missing');
  const remoteSession: unknown = remoteSessions.get(local.id);
  if (!remoteSession || typeof remoteSession !== 'object' || !('channel' in remoteSession) ||
    !(remoteSession.channel instanceof FleetChannel)) throw new Error('Remote channel missing');
  remoteSession.channel.send({ type: 'terminal', id: 'f'.repeat(32),
    projectId: 7, shellIndex: 0, kind: 'data', data: 'forged subscription' });
  remoteSession.channel.send({ type: 'terminal', id: subscriptionId,
    projectId: 8, shellIndex: 0, kind: 'data', data: 'forged project' });
  await a.status(peer.id);
  expect(events.some((event) => event.data.includes('forged'))).toBe(false);
  await vi.waitFor(() => expect(events.some((event) => event.kind === 'data')).toBe(true));
  expect(events.findIndex((event) => event.kind === 'ready')).toBeLessThan(
    events.findIndex((event) => event.kind === 'data'),
  );
  await a.resize(peer.id, 7, 0, 91, 35);
  expect(resize).toHaveBeenCalledWith(7, 0, 91, 35);
  output?.('\x1b[32mready\x1b[0m');
  await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ kind: 'data', data: '\x1b[32mready\x1b[0m' }));
  await a.unsubscribe(peer.id, subscriptionId);
  expect(output).toBeUndefined();
  expect(b.state().controls).toEqual([]);
  await expect(a.resize(peer.id, 7, 0, 92, 36)).rejects.toThrow('Peer refused fleet operation');
  expect(resize).toHaveBeenCalledTimes(1);
  await expect(a.unsubscribe(peer.id, subscriptionId)).rejects.toThrow();
  const next = await a.subscribe(peer.id, 7, 0);
  await vi.waitFor(() => expect(events.some((event) => event.subscriptionId === next.subscriptionId && event.kind === 'ready')).toBe(true));
  exit?.();
  await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ subscriptionId: next.subscriptionId, kind: 'exit' }));
  expect(output).toBeUndefined();
  expect(b.state().controls).toEqual([]);
  vi.spyOn(remoteOps, 'terminalSnapshot').mockResolvedValueOnce('x'.repeat(4_194_305));
  const oversized = await a.subscribe(peer.id, 7, 0);
  await vi.waitFor(() => expect(events.some((event) =>
    event.subscriptionId === oversized.subscriptionId && event.kind === 'exit')).toBe(true));
  expect(events.filter((event) => event.subscriptionId === oversized.subscriptionId)
    .map((event) => event.kind)).toEqual(['exit']);
  expect(output).toBeUndefined();
  const revoked = await a.subscribe(peer.id, 7, 0);
  await vi.waitFor(() => expect(events.some((event) => event.subscriptionId === revoked.subscriptionId && event.kind === 'ready')).toBe(true));
  expect(b.state().controls).toEqual([{ projectId: 7, shellIndex: 0, peerName: 'stream A' }]);
  await a.revoke(peer.id);
  await vi.waitFor(() => expect(output).toBeUndefined());
  await vi.waitFor(() => expect(b.state().controls).toEqual([]));
  expect(events.filter((event) => event.subscriptionId === revoked.subscriptionId).at(-1)?.kind).toBe('ready');
}, 20_000);

it('links two distinct IDE runtimes over real TLS after local discovery; controls and revokes a remote shell', async () => {
  const writes: string[] = [];
  const stopped: string[] = [];
  const localOps: FleetOperations = {
    status: () => ({ roots: [], projects: [], shells: [] }),
    launch: async () => ({ shellIndex: 0 }),
    launchClaude: async () => ({ shellIndex: 0 }),
    profiles: async () => ({ profiles: [], defaultCliName: null }),
    launchCli: async () => ({ shellIndex: 0 }),
    setDefaultCli: async (_id, name) => ({ defaultCliName: name }),
    removeCliProfile: async () => ({ ok: true }),
    stop: async () => {},
    write: async () => {},
    resize: async () => {},
    isAlive: () => false,
    hasProject: () => false,
    watch: () => () => {},
    terminalSnapshot: async () => '',
    snapshot: async () => ({ output: '', alive: false }),
  };
  let remoteStatus: FleetStatus = {
    roots: [{ id: 2, name: 'Workspace' }],
    projects: [{ id: 1, rootId: 2, name: 'Remote project' }],
    shells: [{ projectId: 1, shellIndex: 0, agent: 'omp', state: 'busy',
      launchName: 'Terminal', pinned: false, startedAt: null, lastActiveAt: null }],
  };
  let observedStatus = 0;
  const remoteOps: FleetOperations = {
    status: () => {
      observedStatus++;
      return remoteStatus;
    },
    launch: async (id) => {
      expect(id).toBe(1);
      return { shellIndex: 0 };
    },
    launchClaude: async () => ({ shellIndex: 0 }),
    profiles: async () => ({ profiles: [{ name: 'Agent', scope: 'project', icon: 'A' }], defaultCliName: null }),
    launchCli: async () => ({ shellIndex: 1 }),
    setDefaultCli: async (_id, name) => ({ defaultCliName: name }),
    removeCliProfile: async () => ({ ok: true }),
    stop: async (id, index) => {
      stopped.push(`${id}:${index}`);
    },
    write: async (_id, _index, text) => {
      writes.push(text);
    },
    resize: async () => {},
    isAlive: () => true,
    hasProject: (projectId) => projectId === 1,
    watch: () => () => {},
    terminalSnapshot: async () => '<terminal text>',
    snapshot: async () => ({ output: '<terminal text>', alive: true }),
  };
  function instance(name: string, operations: FleetOperations) {
    const root = mkdtempSync(join(tmpdir(), 'metaide-fleet-smoke-'));
    roots.push(root);
    const service = new FleetService({
      name,
      storageDir: join(root, 'fleet'),
      operations,
      keychain,
    });
    instances.push(service);
    return service;
  }
  const a = instance('Fleet A', localOps);
  const b = instance('Fleet B', remoteOps);
  await a.start();
  await b.start();
  await a.setEnabled(true);
  await b.setEnabled(true);
  // This host's multicast loopback does not deliver even to two raw UDP sockets.
  // Inject only the public discovery beacon; pairing and every command use real TLS.
  announceTo(a, b, 'Fleet B');
  announceTo(b, a, 'Fleet A');
  const idB = a.state().peers.find((peer) => peer.name === 'Fleet B')?.id;
  const idA = b.state().peers.find((peer) => peer.name === 'Fleet A')?.id;
  if (!idA || !idB) throw new Error('Both runtimes must discover one another');
  await expect(a.status(idB)).rejects.toThrow();
  await a.pair(idB);
  await vi.waitFor(
    () => {
      expect(a.state().peers.find((peer) => peer.id === idB)?.status).toBe('pending');
      expect(b.state().peers.find((peer) => peer.id === idA)?.status).toBe('pending');
    },
    { timeout: 10_000, interval: 100 },
  );
  const codeA = a.state().peers.find((peer) => peer.id === idB)?.verificationCode;
  const codeB = b.state().peers.find((peer) => peer.id === idA)?.verificationCode;
  expect(codeA).toBeTruthy();
  expect(codeA).toBe(codeB);
  if (!codeA || !codeB) throw new Error('Comparison codes missing');
  await new Promise<void>((resolve) => setTimeout(resolve, 11_000));
  expect(a.state().peers.find((peer) => peer.id === idB)?.verificationCode).toBe(codeA);
  expect(b.state().peers.find((peer) => peer.id === idA)?.verificationCode).toBe(codeB);
  const incorrectCode = codeA === '0000-0000-0000' ? '9999-9999-9999' : '0000-0000-0000';
  await expect(a.approve(idB, incorrectCode)).rejects.toThrow('Verification code mismatch');
  await expect(a.status(idB)).rejects.toThrow();
  await a.approve(idB, codeA);
  await expect(a.status(idB)).rejects.toThrow();
  expect(a.state().peers.find((peer) => peer.id === idB)?.status).toBe('pending');
  const store: unknown = Reflect.get(b, 'store');
  if (!(store instanceof FleetIdentityStore)) throw new Error('Peer trust store unavailable');
  const originalSave = store.save.bind(store);
  let releaseSave!: () => void;
  const waitForSave = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const saveSpy = vi.spyOn(store, 'save').mockImplementationOnce(async (trust) => {
    await waitForSave;
    await originalSave(trust);
  });
  const approval = b.approve(idA, codeB);
  void approval.catch(() => {});
  let pendingStatus: Promise<FleetStatus> | undefined;
  try {
    await vi.waitFor(
      () => expect(a.state().peers.find((peer) => peer.id === idB)?.status).toBe('linked'),
      { timeout: 10_000, interval: 100 },
    );
    expect(b.state().peers.find((peer) => peer.id === idA)?.status).toBe('pending');
    const remoteSessions: unknown = Reflect.get(b, 'sessions');
    if (!(remoteSessions instanceof Map)) throw new Error('Peer sessions unavailable');
    const remoteSession: unknown = remoteSessions.get(idA);
    if (
      !remoteSession ||
      typeof remoteSession !== 'object' ||
      !('channel' in remoteSession) ||
      !(remoteSession.channel instanceof FleetChannel)
    )
      throw new Error('Peer channel unavailable');
    const inboundSocket = remoteSession.channel.socket;
    if (!(inboundSocket instanceof TLSSocket)) throw new Error('Peer TLS socket unavailable');
    const bytesBeforeRequest = inboundSocket.bytesRead;
    pendingStatus = a.status(idB);
    void pendingStatus.catch(() => {});
    await vi.waitFor(() => expect(inboundSocket.bytesRead).toBeGreaterThan(bytesBeforeRequest), {
      timeout: 10_000,
      interval: 20,
    });
    expect(observedStatus).toBe(0);
  } finally {
    releaseSave();
    saveSpy.mockRestore();
  }
  await approval;
  await vi.waitFor(
    () => expect(b.state().peers.find((peer) => peer.id === idA)?.status).toBe('linked'),
    { timeout: 10_000, interval: 20 },
  );
  if (!pendingStatus) throw new Error('Status was not requested during trust save');
  expect(await pendingStatus).toEqual({
    roots: [{ id: 2, name: 'Workspace' }],
    projects: [{ id: 1, rootId: 2, name: 'Remote project' }],
    shells: [{ projectId: 1, shellIndex: 0, agent: 'omp', state: 'busy',
      launchName: 'Terminal', pinned: false, startedAt: null, lastActiveAt: null }],
  });
  await expect(a.profiles(idB, 1)).resolves.toEqual({
    profiles: [{ name: 'Agent', scope: 'project', icon: 'A' }], defaultCliName: null,
  });
  const launchCli = vi.spyOn(remoteOps, 'launchCli');
  await expect(a.launchCli(idB, 1, { profileName: 'Agent' })).resolves.toEqual({ shellIndex: 1 });
  expect(launchCli).toHaveBeenCalledWith(1, { profileName: 'Agent' });
  await expect(a.launchCli(idB, 1, { profileName: 'Saved', argv: ['agent', '--quiet'], save: true }))
    .resolves.toEqual({ shellIndex: 1 });
  expect(launchCli).toHaveBeenCalledWith(1, { profileName: 'Saved', argv: ['agent', '--quiet'], save: true });
  await expect(a.setDefaultCli(idB, 1, 'Agent')).resolves.toEqual({ defaultCliName: 'Agent' });
  await expect(a.removeCliProfile(idB, 1, 'Agent')).resolves.toEqual({ ok: true });
  await expect(a.launchCli(idB, 1, { argv: ['x'.repeat(1025)] })).rejects.toThrow('Invalid CLI launch');
  expect(launchCli).toHaveBeenCalledTimes(2);
  await expect(a.profiles(idB, 0)).rejects.toThrow('Invalid project ID');
  await expect(a.setDefaultCli(idB, 1, '/secret')).rejects.toThrow('Invalid CLI default');
  await expect(a.removeCliProfile(idB, 1, '')).rejects.toThrow('Invalid CLI profile');
  const profilesSpy = vi.spyOn(remoteOps, 'profiles').mockResolvedValueOnce({
    profiles: [{ name: 'Agent', scope: 'project', icon: '/secret' }], defaultCliName: null,
  });
  await expect(a.profiles(idB, 1)).rejects.toThrow('Peer refused fleet operation');
  profilesSpy.mockRestore();
  const failure = vi.spyOn(remoteOps, 'launchCli').mockRejectedValueOnce(
    new Error('command failed at /secret/bin with TOKEN=private'),
  );
  await expect(a.launchCli(idB, 1, { profileName: 'Agent' }))
    .rejects.toThrow('Peer refused fleet operation');
  failure.mockRestore();
  remoteStatus = {
    roots: [{ id: 2, name: 'Workspace' }],
    projects: Array.from({ length: 91 }, (_, index) => ({
      id: index + 1,
      rootId: 2,
      name: 'P'.repeat(160),
    })),
    shells: [],
  };
  expect(await a.status(idB)).toEqual(remoteStatus);
  remoteStatus = {
    roots: Array.from({ length: 256 }, (_, index) => ({
      id: index + 1, name: `Root ${index + 1}`,
    })),
    projects: Array.from({ length: 256 }, (_, index) => ({
      id: index + 1,
      rootId: index + 1,
      name: String.fromCharCode(1).repeat(160),
    })),
    shells: Array.from({ length: 256 }, (_, index): FleetStatus['shells'][number] => ({
      projectId: index + 1,
      shellIndex: index,
      agent: 'omp',
      state: 'busy',
      launchName: 'Agent', pinned: index % 2 === 0,
      startedAt: '2026-10-21 12:00:00', lastActiveAt: null,
    })),
  };
  expect(await a.status(idB)).toEqual(remoteStatus);
  expect(a.state().peers.find((peer) => peer.id === idB)?.status).toBe('linked');
  const sessions: unknown = Reflect.get(a, 'sessions');
  if (!(sessions instanceof Map)) throw new Error('Live sessions unavailable');
  const session: unknown = sessions.get(idB);
  if (
    session === null ||
    typeof session !== 'object' ||
    !('channel' in session) ||
    !(session.channel instanceof FleetChannel)
  )
    throw new Error('Authenticated channel unavailable');
  const linkedChannel = session.channel;
  const fullStatus = remoteStatus;
  remoteStatus = {
    roots: [{ id: 2, name: 'Workspace' }],
    projects: Array.from({ length: 13 }, (_, index) => ({ id: index + 1, rootId: 2, name: 'Snapshot' })),
    shells: [],
  };
  try {
    const pages = await Promise.all(
      Array.from({ length: 4 }, () =>
        linkedChannel.request('status', { rootOffset: 0, projectOffset: 0, shellOffset: 0 }),
      ),
    );
    const tokens = pages.map((page) => validateStatusPage(page)?.token);
    expect(tokens.every((token) => typeof token === 'string')).toBe(true);
    await expect(
      session.channel.request('status', { rootOffset: 0, projectOffset: 0, shellOffset: 0 }),
    ).rejects.toThrow('Peer refused fleet operation');
    for (const token of tokens) {
      if (!token) throw new Error('Snapshot token missing');
      const lastPage = validateStatusPage(
        await session.channel.request('status', {
          rootOffset: 1,
          projectOffset: 12,
          shellOffset: 0,
          token,
        }),
      );
      expect(lastPage?.projects.map(({ id }) => id)).toEqual([13]);
    }
  } finally {
    remoteStatus = fullStatus;
  }
  const firstPage: unknown = await session.channel.request('status', {
    rootOffset: 0,
    projectOffset: 0,
    shellOffset: 0,
  });
  if (
    firstPage === null ||
    typeof firstPage !== 'object' ||
    !('token' in firstPage) ||
    typeof firstPage.token !== 'string'
  )
    throw new Error('Status page missing token');
  const capturedStatus = remoteStatus;
  remoteStatus = { roots: [], projects: [], shells: [] };
  try {
    const next = validateStatusPage(
      await session.channel.request('status', {
        rootOffset: 2,
        projectOffset: 12,
        shellOffset: 12,
        token: firstPage.token,
      }),
    );
    expect(next?.roots[0]?.id).toBe(3);
    expect(next?.projects[0]?.id).toBe(13);
    expect(next?.shells[0]?.shellIndex).toBe(12);
    expect(next?.projectTotal).toBe(256);
  } finally {
    remoteStatus = capturedStatus;
  }
  await expect(
    session.channel.request('status', {
      rootOffset: 256,
      projectOffset: 256,
      shellOffset: 0,
      token: firstPage.token,
    }),
  ).rejects.toThrow('Peer refused fleet operation');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11_000);
  try {
    await expect(
      session.channel.request('status', {
        rootOffset: 4,
        projectOffset: 24,
        shellOffset: 24,
        token: firstPage.token,
      }),
    ).rejects.toThrow('Peer refused fleet operation');
  } finally {
    clock.mockRestore();
  }
  expect(await a.status(idB)).toEqual(remoteStatus);
  expect(await a.launch(idB, 1)).toEqual({ shellIndex: 0 });
  expect(await a.snapshot(idB, 1, 0)).toEqual({ output: '<terminal text>', alive: true });
  await a.write(idB, 1, 0, 'echo smoke\r');
  await a.stopShell(idB, 1, 0);
  expect(writes).toEqual(['echo smoke\r']);
  expect(stopped).toEqual(['1:0']);
  for (let i = 0; i < 4; i++) {
    const page = validateStatusPage(
      await session.channel.request('status', { rootOffset: 0, projectOffset: 0, shellOffset: 0 }),
    );
    expect(page?.projects).toHaveLength(12);
  }
  await expect(
    session.channel.request('status', { rootOffset: 0, projectOffset: 0, shellOffset: 0 }),
  ).rejects.toThrow('Peer refused fleet operation');
  expect(a.state().peers.find((peer) => peer.id === idB)?.status).toBe('linked');
  const server: unknown = Reflect.get(b, 'server');
  const discovery: unknown = Reflect.get(a, 'discovery');
  if (!(server instanceof TlsServer) || !(discovery instanceof FleetDiscovery))
    throw new Error('Live TLS transport unavailable');
  const presence = discovery.list().find((peer) => peer.id === idB);
  const dial: unknown = Reflect.get(a, 'dial');
  if (!presence || typeof dial !== 'function') throw new Error('Trusted peer unavailable');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Listener unavailable');
  const slow: Socket[] = [];
  try {
    for (let i = 0; i < 16; i++) {
      const socket = connectTcp(address.port, '127.0.0.1');
      slow.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
    }
    await vi.waitFor(
      () => {
        expect(slow.filter((socket) => !socket.destroyed)).toHaveLength(2);
      },
      { timeout: 5_000 },
    );
    session.channel.close();
    await dial.call(a, presence);
    await vi.waitFor(
      () => {
        expect(a.state().peers.find((peer) => peer.id === idB)?.status).toBe('linked');
        expect(b.state().peers.find((peer) => peer.id === idA)?.status).toBe('linked');
      },
      { timeout: 10_000 },
    );
    expect(await a.status(idB)).toEqual(remoteStatus);
    const stalled = connectTcp(address.port, '127.0.0.1');
    slow.push(stalled);
    await new Promise<void>((resolve, reject) => {
      stalled.once('connect', resolve);
      stalled.once('error', reject);
    });
    stalled.resume();
    await vi.waitFor(() => expect(stalled.destroyed).toBe(true), { timeout: 5_000 });
  } finally {
    for (const socket of slow) socket.destroy();
  }
  await a.revoke(idB);
  await expect(a.status(idB)).rejects.toThrow();
  await vi.waitFor(
    () => {
      expect(b.state().peers.find((peer) => peer.id === idA)?.status).toBe('offline');
    },
    { timeout: 10_000, interval: 100 },
  );
}, 45_000);

it('keeps one comparison code when both devices request a link at once', async () => {
  const operations: FleetOperations = {
    status: () => ({ roots: [], projects: [], shells: [] }),
    launch: async () => ({ shellIndex: 0 }),
    launchClaude: async () => ({ shellIndex: 0 }),
    profiles: async () => ({ profiles: [], defaultCliName: null }),
    launchCli: async () => ({ shellIndex: 0 }),
    setDefaultCli: async (_id, name) => ({ defaultCliName: name }),
    removeCliProfile: async () => ({ ok: true }),
    stop: async () => {},
    write: async () => {},
    resize: async () => {},
    isAlive: () => false,
    hasProject: () => false,
    watch: () => () => {},
    terminalSnapshot: async () => '',
    snapshot: async () => ({ output: '', alive: false }),
  };
  function instance(name: string) {
    const root = mkdtempSync(join(tmpdir(), 'metaide-fleet-pair-'));
    roots.push(root);
    const fleet = new FleetService({
      name,
      storageDir: join(root, 'fleet'),
      operations,
      keychain,
    });
    instances.push(fleet);
    return fleet;
  }
  const a = instance('Fleet C');
  const b = instance('Fleet D');
  await a.start();
  await b.start();
  await a.setEnabled(true);
  await b.setEnabled(true);
  announceTo(a, b, 'Fleet D');
  announceTo(b, a, 'Fleet C');
  const idB = a.state().peers.find((peer) => peer.name === 'Fleet D')?.id;
  const idA = b.state().peers.find((peer) => peer.name === 'Fleet C')?.id;
  if (!idA || !idB) throw new Error('Both runtimes must discover one another');
  await Promise.all([a.pair(idB), b.pair(idA)]);
  await vi.waitFor(
    () => {
      const pendingA = a.state().peers.find((peer) => peer.id === idB);
      const pendingB = b.state().peers.find((peer) => peer.id === idA);
      expect(pendingA?.status).toBe('pending');
      expect(pendingA?.verificationCode).toMatch(/^\d{4}-\d{4}-\d{4}$/);
      expect(pendingB?.verificationCode).toBe(pendingA?.verificationCode);
    },
    { timeout: 5_000, interval: 100 },
  );
  const code = a.state().peers.find((peer) => peer.id === idB)?.verificationCode;
  if (!code) throw new Error('Comparison code missing');
  await a.approve(idB, code);
  await b.approve(idA, code);
  await vi.waitFor(() =>
    expect(a.state().peers.find((peer) => peer.id === idB)?.status).toBe('linked'),
  );
  await vi.waitFor(() =>
    expect(b.state().peers.find((peer) => peer.id === idA)?.status).toBe('linked'),
  );
}, 15_000);
