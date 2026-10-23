/** Fleet git-status requests and host-to-controller Claude notices over hermetic in-memory channels. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Duplex } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetGitStatus } from '@shared/fleet-contract';
import { FleetService, type FleetNoticeEvent, type FleetOperations } from '@main/fleet/service';
import type { FleetKeychain } from '@main/fleet/identity';
import { decodeMessage } from '@main/fleet/protocol';

const PEER = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const STRANGER = 'c'.repeat(64);
const REPO: FleetGitStatus = {
  isRepo: true,
  branch: 'main',
  dirty: true,
  ahead: 2,
  behind: 1,
  changedCount: 5,
};
const vault = new Map<string, string>();
const keychain: FleetKeychain = {
  getPassword: async (service, account) => vault.get(`${service}:${account}`) ?? null,
  setPassword: async (service, account, password) => {
    vault.set(`${service}:${account}`, password);
  },
  deletePassword: async (service, account) => vault.delete(`${service}:${account}`),
};
const dirs: string[] = [];
const fleets: FleetService[] = [];
afterEach(async () => {
  for (const fleet of fleets.splice(0)) await fleet.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const operations = (): FleetOperations => ({
  status: () => ({ roots: [], projects: [], shells: [] }),
  launch: async () => ({ shellIndex: 0 }),
  launchClaude: async () => ({ shellIndex: 0 }),
  profiles: async () => ({ profiles: [], defaultCliName: null }),
  launchCli: async () => ({ shellIndex: 0 }),
  setDefaultCli: async (_projectId, name) => ({ defaultCliName: name }),
  removeCliProfile: async () => ({ ok: true }),
  stop: async () => {},
  write: async () => {},
  resize: async () => {},
  isAlive: () => true,
  hasProject: () => true,
  watch: () => () => {},
  snapshot: async () => ({ output: '', alive: true }),
  terminalSnapshot: async () => '',
  gitStatus: async () => REPO,
});

type Frame = Record<string, unknown>;
interface Connection {
  readonly sent: Frame[];
  readonly socket: Duplex;
  push(frame: object): void;
  respond(op: string, value: unknown): void;
}

function fleet(ops: FleetOperations = operations()): FleetService {
  const storageDir = mkdtempSync(join(tmpdir(), 'fleet-notices-'));
  dirs.push(storageDir);
  const service = new FleetService({ name: 'Local', storageDir, operations: ops, keychain });
  Reflect.set(service, 'started', true);
  Reflect.set(service, 'trust', {
    enabled: true,
    trusted: [
      { id: PEER, name: 'Laptop' },
      { id: OTHER, name: 'Desk' },
    ],
    revoked: [],
  });
  fleets.push(service);
  return service;
}

function connect(service: FleetService, peerId: string, hello = true): Connection {
  const sent: Frame[] = [];
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString().split('\n').filter(Boolean))
        sent.push(JSON.parse(line) as Frame);
      done();
    },
  });
  Reflect.set(socket, 'setKeepAlive', () => socket);
  const attach: unknown = Reflect.get(service, 'attachSession');
  if (typeof attach !== 'function') throw new Error('attachSession seam unavailable');
  attach.call(service, socket, peerId, true);
  const push = (frame: object): void => {
    socket.push(Buffer.from(`${JSON.stringify(frame)}\n`));
  };
  const respond = (op: string, value: unknown): void => {
    const request = sent.filter((frame) => frame.type === 'request' && frame.op === op).at(-1);
    if (!request) throw new Error(`no ${op} request sent`);
    push({ type: 'response', id: request.id, ok: true, value });
  };
  if (hello) push({ type: 'hello', id: 'd'.repeat(32), nonce: 'e'.repeat(64) });
  return { sent, socket, push, respond };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const notices = (connection: Connection): Frame[] =>
  connection.sent.filter((frame) => frame.type === 'notice');
const NOTICE = {
  projectId: 7,
  shellIndex: 0,
  kind: 'needs-input',
  body: 'Claude needs your permission',
} as const;

async function controlled(
  service: FleetService,
  peerId: string,
  projectId = 7,
  shellIndex = 0,
): Promise<Connection> {
  const connection = connect(service, peerId);
  await tick();
  connection.push({
    type: 'request',
    id: '1'.repeat(32),
    op: 'subscribe',
    args: { projectId, shellIndex, subscriptionId: '2'.repeat(32) },
  });
  await vi.waitFor(() =>
    expect(connection.sent.some((frame) => frame.type === 'response' && frame.ok === true)).toBe(
      true,
    ),
  );
  return connection;
}

describe('host notices to controlling peers', () => {
  it('sends one exact, decodable notice to the trusted session controlling the shell', async () => {
    const host = fleet();
    const controller = await controlled(host, PEER);
    const bystander = connect(host, OTHER);
    await tick();
    expect(host.sendNotice(NOTICE)).toBe(1);
    expect(notices(controller)).toHaveLength(1);
    const frame = notices(controller)[0]!;
    expect(decodeMessage(JSON.stringify(frame))).toEqual({
      type: 'notice',
      id: frame.id,
      ...NOTICE,
    });
    expect(frame.id).toMatch(/^[a-f0-9]{32}$/);
    expect(notices(bystander)).toEqual([]);
  });

  it('sends nothing for a shell no peer controls, so the host notifies locally', async () => {
    const host = fleet();
    const controller = await controlled(host, PEER, 7, 1);
    expect(host.sendNotice(NOTICE)).toBe(0);
    expect(host.sendNotice({ ...NOTICE, projectId: 8, shellIndex: 1 })).toBe(0);
    expect(notices(controller)).toEqual([]);
  });

  it('sends nothing to a controller whose trust was withdrawn or whose fleet is disabled', async () => {
    const host = fleet();
    const controller = await controlled(host, PEER);
    Reflect.set(host, 'trust', {
      enabled: true,
      trusted: [{ id: OTHER, name: 'Desk' }],
      revoked: [],
    });
    expect(host.sendNotice(NOTICE)).toBe(0);
    Reflect.set(host, 'trust', {
      enabled: true,
      trusted: [{ id: PEER, name: 'Laptop' }],
      revoked: [PEER],
    });
    expect(host.sendNotice(NOTICE)).toBe(0);
    Reflect.set(host, 'trust', {
      enabled: false,
      trusted: [{ id: PEER, name: 'Laptop' }],
      revoked: [],
    });
    expect(host.sendNotice(NOTICE)).toBe(0);
    expect(notices(controller)).toEqual([]);
  });

  it('sends nothing once the controlled shell has exited', async () => {
    let exit: (() => void) | undefined;
    const ops = {
      ...operations(),
      watch: (_p: number, _s: number, _d: (data: string) => void, onExit: () => void) => {
        exit = onExit;
        return () => {};
      },
    };
    const host = fleet(ops);
    const controller = await controlled(host, PEER);
    exit?.();
    expect(host.sendNotice(NOTICE)).toBe(0);
    expect(notices(controller)).toEqual([]);
  });

  it('counts no notice and drops the channel when the send fails, so the host notifies locally', async () => {
    const host = fleet();
    const controller = await controlled(host, PEER);
    const session: unknown = Reflect.get(host, 'sessions').get(PEER);
    const channel: unknown =
      session && typeof session === 'object' ? Reflect.get(session, 'channel') : null;
    if (!channel || typeof channel !== 'object') throw new Error('channel seam unavailable');
    vi.spyOn(channel as { send: () => void }, 'send').mockImplementation(() => {
      throw new Error('Fleet channel backpressure limit');
    });
    expect(host.sendNotice(NOTICE)).toBe(0);
    expect(controller.socket.destroyed).toBe(true);
  });

  it('never forwards a body or kind the controller would reject', async () => {
    const host = fleet();
    const controller = await controlled(host, PEER);
    for (const bad of [
      { ...NOTICE, body: 'x'.repeat(201) },
      { ...NOTICE, body: 'bell\x07' },
      { ...NOTICE, body: '' },
      { ...NOTICE, kind: 'command-finished' as unknown as 'finished' },
      { ...NOTICE, projectId: 0 },
    ])
      expect(host.sendNotice(bad)).toBe(0);
    expect(notices(controller)).toEqual([]);
  });
});

describe('controller handling of peer notices', () => {
  const page = {
    roots: [{ id: 3, name: 'Root' }],
    projects: [{ id: 7, rootId: 3, name: 'Remote app' }],
    shells: [],
    rootOffset: 0,
    projectOffset: 0,
    shellOffset: 0,
    rootTotal: 1,
    projectTotal: 1,
    shellTotal: 0,
    token: 'f'.repeat(32),
  };

  async function subscribed(
    projectId = 7,
    shellIndex = 0,
  ): Promise<{ controller: FleetService; host: Connection; events: FleetNoticeEvent[] }> {
    const controller = fleet();
    const host = connect(controller, PEER);
    await tick();
    const events: FleetNoticeEvent[] = [];
    controller.onNotice((event) => events.push(event));
    const subscription = controller.subscribe(PEER, projectId, shellIndex);
    const request = host.sent.find((frame) => frame.type === 'request' && frame.op === 'subscribe');
    const args = request?.args as { subscriptionId: string } | undefined;
    host.respond('subscribe', { subscriptionId: args?.subscriptionId });
    await subscription;
    return { controller, host, events };
  }

  it('emits a notice for a subscribed shell with the peer name and the last known project name', async () => {
    const { controller, host, events } = await subscribed();
    const status = controller.status(PEER);
    await vi.waitFor(() => expect(host.sent.some((frame) => frame.op === 'status')).toBe(true));
    host.respond('status', page);
    await status;
    host.push({ type: 'notice', id: '3'.repeat(32), ...NOTICE });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({
      peerId: PEER,
      peerName: 'Laptop',
      projectName: 'Remote app',
      ...NOTICE,
    });
  });

  it('reports an unknown project name as null when no status has been read', async () => {
    const { host, events } = await subscribed();
    host.push({
      type: 'notice',
      id: '3'.repeat(32),
      ...NOTICE,
      kind: 'finished',
      body: 'Claude finished and is waiting for you',
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ projectName: null, kind: 'finished' });
  });

  it('ignores a notice for a shell it does not subscribe to', async () => {
    const { host, events } = await subscribed(7, 1);
    host.push({ type: 'notice', id: '3'.repeat(32), ...NOTICE });
    host.push({ type: 'notice', id: '4'.repeat(32), ...NOTICE, projectId: 8, shellIndex: 1 });
    await tick();
    await tick();
    expect(events).toEqual([]);
    expect(host.socket.destroyed).toBe(false);
  });

  it('ignores a notice from an untrusted, pending session', async () => {
    const controller = fleet();
    const events: FleetNoticeEvent[] = [];
    controller.onNotice((event) => events.push(event));
    const stranger = connect(controller, STRANGER);
    await tick();
    expect(controller.state().peers.find((peer) => peer.id === STRANGER)?.status).toBe('pending');
    const outgoing: unknown = Reflect.get(
      Reflect.get(controller, 'sessions').get(STRANGER),
      'outgoing',
    );
    if (!(outgoing instanceof Map)) throw new Error('outgoing seam unavailable');
    outgoing.set('5'.repeat(32), { projectId: 7, shellIndex: 0 });
    stranger.push({ type: 'notice', id: '3'.repeat(32), ...NOTICE });
    await tick();
    await tick();
    expect(events).toEqual([]);
  });

  it('closes a session that sends a notice before its hello and emits nothing', async () => {
    const controller = fleet();
    const events: FleetNoticeEvent[] = [];
    controller.onNotice((event) => events.push(event));
    const early = connect(controller, PEER, false);
    early.push({ type: 'notice', id: '3'.repeat(32), ...NOTICE });
    await vi.waitFor(() => expect(early.socket.destroyed).toBe(true));
    expect(events).toEqual([]);
  });

  it('ignores a notice once the peer is no longer trusted', async () => {
    const { controller, host, events } = await subscribed();
    Reflect.set(controller, 'trust', {
      enabled: true,
      trusted: [{ id: OTHER, name: 'Desk' }],
      revoked: [],
    });
    host.push({ type: 'notice', id: '3'.repeat(32), ...NOTICE });
    await tick();
    await tick();
    expect(events).toEqual([]);
  });

  it('closes the channel on a malformed notice and emits nothing', async () => {
    const { host, events } = await subscribed();
    host.push({ type: 'notice', id: '3'.repeat(32), ...NOTICE, title: 'spoofed' });
    await vi.waitFor(() => expect(host.socket.destroyed).toBe(true));
    expect(events).toEqual([]);
  });

  it('stops delivering after the listener unsubscribes', async () => {
    const { controller, host } = await subscribed();
    const listener = vi.fn();
    const off = controller.onNotice(listener);
    off();
    host.push({ type: 'notice', id: '3'.repeat(32), ...NOTICE });
    await tick();
    await tick();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('remote git status', () => {
  it('returns the validated summary from a linked peer', async () => {
    const controller = fleet();
    const host = connect(controller, PEER);
    await tick();
    const result = controller.gitStatus(PEER, 7);
    await vi.waitFor(() => expect(host.sent.some((frame) => frame.op === 'git-status')).toBe(true));
    expect(host.sent.find((frame) => frame.op === 'git-status')?.args).toEqual({ projectId: 7 });
    host.respond('git-status', REPO);
    await expect(result).resolves.toEqual(REPO);
  });

  it('rejects an unbounded or path-carrying response', async () => {
    for (const bad of [
      { ...REPO, files: { 'secret.txt': 'M' } },
      { ...REPO, branch: 'x'.repeat(256) },
      { ...REPO, changedCount: -1 },
      null,
    ]) {
      const controller = fleet();
      const host = connect(controller, PEER);
      await tick();
      const result = controller.gitStatus(PEER, 7);
      await vi.waitFor(() =>
        expect(host.sent.some((frame) => frame.op === 'git-status')).toBe(true),
      );
      host.respond('git-status', bad);
      await expect(result).rejects.toThrow('Invalid peer git status');
    }
  });

  it('rejects a cast project ID or an unlinked peer before sending anything', async () => {
    const controller = fleet();
    const host = connect(controller, PEER);
    await tick();
    const settled = (result: Promise<unknown>): Promise<unknown> =>
      Promise.race([result, tick().then(() => 'still pending')]);
    for (const projectId of [0, -1, 1.5, '7' as unknown as number, 1_000_001])
      await expect(settled(controller.gitStatus(PEER, projectId))).rejects.toThrow(
        'Invalid project ID',
      );
    await expect(controller.gitStatus(STRANGER, 7)).rejects.toThrow(
      'Peer is not linked and online',
    );
    await expect(controller.gitStatus(42 as unknown as string, 7)).rejects.toThrow(
      'Peer is not linked and online',
    );
    expect(host.sent.filter((frame) => frame.type === 'request')).toEqual([]);
  });

  it('serves git-status to a trusted peer through the bounded operation', async () => {
    const ops = operations();
    const gitStatus = vi.spyOn(ops, 'gitStatus');
    const host = fleet(ops);
    const peer = connect(host, PEER);
    await tick();
    peer.push({ type: 'request', id: '6'.repeat(32), op: 'git-status', args: { projectId: 7 } });
    await vi.waitFor(() => expect(peer.sent.some((frame) => frame.type === 'response')).toBe(true));
    expect(gitStatus).toHaveBeenCalledWith(7);
    expect(peer.sent.find((frame) => frame.type === 'response')).toEqual({
      type: 'response',
      id: '6'.repeat(32),
      ok: true,
      value: REPO,
    });
  });

  it('refuses rather than forwards an operation result that fails validation', async () => {
    const ops = {
      ...operations(),
      gitStatus: async () =>
        ({ ...REPO, files: { '/private/secret': 'M' } }) as unknown as FleetGitStatus,
    };
    const host = fleet(ops);
    const peer = connect(host, PEER);
    await tick();
    peer.push({ type: 'request', id: '6'.repeat(32), op: 'git-status', args: { projectId: 7 } });
    await vi.waitFor(() => expect(peer.sent.some((frame) => frame.type === 'response')).toBe(true));
    expect(peer.sent.find((frame) => frame.type === 'response')).toEqual({
      type: 'response',
      id: '6'.repeat(32),
      ok: false,
    });
    expect(JSON.stringify(peer.sent)).not.toContain('secret');
  });

  it('never serves git-status to an untrusted session', async () => {
    const ops = operations();
    const gitStatus = vi.spyOn(ops, 'gitStatus');
    const host = fleet(ops);
    const stranger = connect(host, STRANGER);
    await tick();
    stranger.push({
      type: 'request',
      id: '6'.repeat(32),
      op: 'git-status',
      args: { projectId: 7 },
    });
    await vi.waitFor(() => expect(stranger.socket.destroyed).toBe(true));
    expect(gitStatus).not.toHaveBeenCalled();
  });
});

describe('viewed remote shell', () => {
  it('records and clears the shell the window shows', () => {
    const service = fleet();
    expect(service.viewing()).toBeNull();
    service.setViewing({ peerId: PEER, projectId: 7, shellIndex: 0 });
    expect(service.viewing()).toEqual({ peerId: PEER, projectId: 7, shellIndex: 0 });
    service.setViewing(null);
    expect(service.viewing()).toBeNull();
  });
});
