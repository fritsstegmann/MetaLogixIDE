/** Opt-in fleet service authenticates TLS peers before exposing local shell callbacks. */
import { randomBytes, X509Certificate } from 'node:crypto';
import { connect, createServer, type Server, type TLSSocket } from 'node:tls';
import type { FleetState, FleetStatus } from '../../shared/fleet-contract';
import { FleetChannel } from './channel';
import { FleetDiscovery, type Presence } from './discovery';
import {
  FleetIdentityStore,
  type FleetIdentity,
  type FleetKeychain,
  type FleetTrust,
} from './identity';
import {
  certificateIdentity,
  pairingCode,
  validateSnapshot,
  validateStatus,
  type WireMessage,
} from './protocol';

/** Shell callbacks must invoke the existing local IPC handlers and preserve local launch policy. */
export interface FleetOperations {
  readonly status: () => Promise<FleetStatus> | FleetStatus;
  readonly launch: (projectId: number) => Promise<{ shellIndex: number }>;
  readonly stop: (projectId: number, shellIndex: number) => Promise<void>;
  readonly write: (projectId: number, shellIndex: number, data: string) => Promise<void>;
  readonly snapshot: (
    projectId: number,
    shellIndex: number,
  ) => Promise<{ output: string; alive: boolean }>;
}
export interface FleetOptions {
  readonly name: string;
  readonly storageDir: string;
  readonly operations: FleetOperations;
  readonly keychain?: FleetKeychain;
}
interface Session {
  readonly id: string;
  readonly channel: FleetChannel;
  readonly localNonce: string;
  readonly helloId: string;
  remoteNonce?: string;
  remoteHelloId?: string;
  code?: string;
  approvedLocal: boolean;
  approvedRemote: boolean;
  deadline?: NodeJS.Timeout;
}
const ID = /^[a-f0-9]{64}$/;

/** Owns local trust, multicast discovery, mutual TLS lifecycle and authorization per operation. */
export class FleetService {
  private readonly store: FleetIdentityStore;
  private readonly listeners = new Set<(state: FleetState) => void>();
  private readonly sessions = new Map<string, Session>();
  private readonly attempts = new Map<string, { count: number; since: number }>();
  private trust: FleetTrust = { enabled: false, trusted: [], revoked: [] };
  private identity: FleetIdentity | null = null;
  private server: Server | null = null;
  private discovery: FleetDiscovery | null = null;
  private presence: readonly Presence[] = [];
  private reconnectTimer: NodeJS.Timeout | undefined;
  private started = false;
  private starting: Promise<void> | null = null;
  private networkError: string | null = null;

  constructor(private readonly options: FleetOptions) {
    if (!options.name.trim() || Buffer.byteLength(options.name, 'utf8') > 80)
      throw new Error('Invalid fleet machine name');
    this.store = new FleetIdentityStore(options.storageDir, options.keychain);
  }

  /** Loads persisted opt-in and starts network listeners only if enabled. */
  async start(): Promise<void> {
    if (this.started) return;
    try {
      this.trust = await this.store.load();
      this.started = true;
      if (this.trust.enabled) await this.open();
      this.networkError = null;
    } catch {
      this.started = true;
      this.networkError =
        'Fleet network unavailable. Check the local network and credential store, then disable and re-enable fleet.';
      await this.closeNetwork();
    }
    this.notify();
  }

  /** Tears down transport, pending approvals and timers without changing saved opt-in. */
  async stop(): Promise<void> {
    this.started = false;
    clearInterval(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.discovery?.stop();
    this.discovery = null;
    for (const session of this.sessions.values()) {
      clearTimeout(session.deadline);
      session.channel.close();
    }
    this.sessions.clear();
    const server = this.server;
    this.server = null;
    if (server)
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    this.presence = [];
    this.notify();
  }

  /** Returns only public peer identity before approval and never includes terminal content. */
  state(): FleetState {
    const peers = this.presence
      .filter((peer) => !this.trust.revoked.includes(peer.id))
      .map((peer) => {
        const session = this.sessions.get(peer.id);
        const linked = this.trust.trusted.some((item) => item.id === peer.id);
        return {
          id: peer.id,
          name: linked
            ? (this.trust.trusted.find((item) => item.id === peer.id)?.name ?? peer.name)
            : peer.name,
          status:
            session?.code && !linked
              ? ('pending' as const)
              : linked && session?.remoteNonce
                ? ('linked' as const)
                : linked
                  ? ('offline' as const)
                  : ('discovered' as const),
          ...(session?.code && !linked ? { verificationCode: session.code } : {}),
        };
      });
    for (const trusted of this.trust.trusted)
      if (!peers.some((peer) => peer.id === trusted.id))
        peers.push({ id: trusted.id, name: trusted.name, status: 'offline' });
    for (const session of this.sessions.values()) {
      if (
        !session.code ||
        peers.some((peer) => peer.id === session.id) ||
        this.trust.revoked.includes(session.id)
      )
        continue;
      peers.push({
        id: session.id,
        name: session.id.slice(0, 12),
        status: 'pending',
        verificationCode: session.code,
      });
    }
    return {
      enabled: this.trust.enabled && this.started,
      peers,
      ...(this.networkError ? { error: this.networkError } : {}),
    };
  }

  /** Subscribes to discovery, pairing, connectivity and trust changes. */
  onChanged(listener: (state: FleetState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const state = this.state();
    for (const listener of this.listeners) listener(state);
  }

  /** Persists opt-in before opening transport; disabling revokes live access immediately. */
  async setEnabled(enabled: boolean): Promise<FleetState> {
    if (!this.started) throw new Error('Fleet service not started');
    if (this.trust.enabled === enabled) return this.state();
    const prior = this.trust;
    this.trust = { ...prior, enabled };
    try {
      await this.store.save(this.trust);
    } catch (error) {
      this.trust = prior;
      throw error;
    }
    if (enabled) {
      try {
        await this.open();
      } catch (error) {
        this.trust = prior;
        this.networkError =
          'Fleet network unavailable. Check the local network and credential store, then retry.';
        await this.store.save(prior);
        await this.closeNetwork();
        this.notify();
        throw error;
      }
    } else await this.closeNetwork();
    this.networkError = null;
    this.notify();
    return this.state();
  }

  private async closeNetwork(): Promise<void> {
    clearInterval(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.discovery?.stop();
    this.discovery = null;
    for (const session of this.sessions.values()) session.channel.close();
    this.sessions.clear();
    const server = this.server;
    this.server = null;
    if (server)
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    this.presence = [];
  }

  private networkFailed(): void {
    if (!this.trust.enabled) return;
    this.networkError =
      'Fleet network unavailable. Check the local network and firewall, then disable and re-enable fleet.';
    void this.closeNetwork().then(() => this.notify());
  }

  private async open(): Promise<void> {
    if (this.server) return;
    this.identity = await this.store.loadIdentity(
      this.trust.trusted.length > 0 || this.trust.revoked.length > 0,
    );
    const identity = this.identity;
    const server = createServer(
      {
        key: identity.key,
        cert: identity.cert,
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.3',
        handshakeTimeout: 10_000,
      },
      (socket) => {
        try {
          this.accept(socket);
        } catch {
          socket.destroy();
        }
      },
    );
    server.maxConnections = 16;
    this.server = server;
    server.on('error', () => this.networkFailed());
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '0.0.0.0', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Fleet listener unavailable');
      this.discovery = new FleetDiscovery(
        identity.id,
        this.options.name,
        (peers) => {
          this.presence = peers;
          this.notify();
          this.reconnect();
        },
        () => this.networkFailed(),
      );
      await this.discovery.start(address.port);
      this.reconnectTimer = setInterval(() => {
        this.reconnect();
      }, 5000);
    } catch (error) {
      await this.closeNetwork();
      throw error;
    }
  }

  private reconnect(): void {
    if (!this.identity || !this.trust.enabled) return;
    for (const peer of this.presence) {
      if (
        !this.trust.trusted.some((item) => item.id === peer.id) ||
        this.identity.id > peer.id ||
        this.sessions.has(peer.id)
      )
        continue;
      void this.dial(peer).catch(() => {
        this.notify();
      });
    }
  }

  private async dial(peer: Presence): Promise<void> {
    if (!this.identity || this.sessions.has(peer.id)) return;
    if (this.starting) {
      try {
        await this.starting;
      } catch {
        /* another peer's failure must not cancel this dial */
      }
      if (this.sessions.has(peer.id)) return;
    }
    const identity = this.identity;
    const connection = new Promise<void>((resolve, reject) => {
      const socket = connect(
        {
          host: peer.host,
          port: peer.port,
          key: identity.key,
          cert: identity.cert,
          rejectUnauthorized: false,
          minVersion: 'TLSv1.2',
          timeout: 10_000,
        },
        () => {
          try {
            if (this.accept(socket, peer.id)) resolve();
            else reject(new Error('Peer TLS identity does not match discovery'));
          } catch (error) {
            socket.destroy();
            reject(error);
          }
        },
      );
      socket.once('error', reject);
      socket.once('timeout', () => {
        socket.destroy();
        reject(new Error('Fleet connection timeout'));
      });
    });
    this.starting = connection;
    try {
      await connection;
    } finally {
      this.starting = null;
    }
  }

  private certificate(socket: TLSSocket): string | null {
    const peer = socket.getPeerCertificate(true);
    if (!peer.raw || peer.raw.length > 8192) return null;
    const cert = new X509Certificate(peer.raw);
    const from = Date.parse(cert.validFrom);
    const to = Date.parse(cert.validTo);
    if (
      !cert.verify(cert.publicKey) ||
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      from > Date.now() ||
      to < Date.now()
    )
      return null;
    return certificateIdentity(peer.raw);
  }

  private accept(socket: TLSSocket, expected?: string): boolean {
    if (!this.trust.enabled || !this.identity || this.sessions.size >= 16) {
      socket.destroy();
      return false;
    }
    let id: string | null;
    try {
      id = this.certificate(socket);
    } catch {
      id = null;
    }
    if (
      !id ||
      (expected && id !== expected) ||
      this.trust.revoked.includes(id) ||
      id === this.identity.id
    ) {
      socket.destroy();
      return false;
    }
    if (
      !this.trust.trusted.some((peer) => peer.id === id) &&
      !this.presence.some((peer) => peer.id === id)
    ) {
      socket.destroy();
      return false;
    }
    if (!this.limit(socket.remoteAddress ?? id)) {
      socket.destroy();
      return false;
    }
    const old = this.sessions.get(id);
    if (old) old.channel.close();
    socket.setKeepAlive(true, 10_000);
    const channel = new FleetChannel(socket);
    const session: Session = {
      id,
      channel,
      localNonce: randomBytes(32).toString('hex'),
      helloId: randomBytes(16).toString('hex'),
      approvedLocal: false,
      approvedRemote: false,
    };
    this.sessions.set(id, session);
    channel.onClose(() => {
      clearTimeout(session.deadline);
      if (this.sessions.get(id) === session) {
        this.sessions.delete(id);
        this.notify();
      }
    });
    channel.onMessage((message) => {
      void this.handle(session, message).catch(() => {
        channel.close();
      });
    });
    session.deadline = setTimeout(() => {
      if (!this.trust.trusted.some((peer) => peer.id === id)) channel.close();
    }, 90_000);
    channel.send({ type: 'hello', id: session.helloId, nonce: session.localNonce });
    return true;
  }

  private limit(address: string): boolean {
    const now = Date.now();
    const entry = this.attempts.get(address);
    if (!entry || now - entry.since >= 60_000) {
      this.attempts.set(address, { count: 1, since: now });
      return true;
    }
    entry.count++;
    if (this.attempts.size > 512) this.attempts.clear();
    return entry.count <= 8;
  }

  private async handle(session: Session, message: WireMessage): Promise<void> {
    if (
      this.sessions.get(session.id) !== session ||
      this.trust.revoked.includes(session.id) ||
      !this.trust.enabled
    ) {
      session.channel.close();
      return;
    }
    if (message.type === 'hello') {
      if (session.remoteNonce || message.nonce === session.localNonce) {
        session.channel.close();
        return;
      }
      session.remoteNonce = message.nonce;
      session.remoteHelloId = message.id;
      if (!this.trust.trusted.some((peer) => peer.id === session.id))
        session.code = pairingCode(
          this.identity?.id ?? '',
          session.id,
          session.localNonce,
          message.nonce,
        );
      this.notify();
      return;
    }
    if (!session.remoteNonce) {
      session.channel.close();
      return;
    }
    if (message.type === 'approve') {
      if (
        !session.code ||
        message.id !== session.remoteHelloId ||
        message.nonce !== session.localNonce ||
        session.approvedRemote
      ) {
        session.channel.close();
        return;
      }
      session.approvedRemote = true;
      await this.finishPair(session);
      return;
    }
    if (message.type !== 'request' || !this.trust.trusted.some((peer) => peer.id === session.id)) {
      session.channel.close();
      return;
    }
    await this.dispatch(session, message);
  }

  private async finishPair(session: Session): Promise<void> {
    if (
      !session.approvedLocal ||
      !session.approvedRemote ||
      !session.code ||
      this.sessions.get(session.id) !== session ||
      this.trust.revoked.includes(session.id)
    )
      return;
    const presence = this.presence.find((peer) => peer.id === session.id);
    const prior = this.trust;
    const next: FleetTrust = {
      ...prior,
      trusted: [
        ...prior.trusted,
        { id: session.id, name: presence?.name ?? session.id.slice(0, 12) },
      ],
    };
    this.trust = next;
    try {
      await this.store.save(next);
    } catch (error) {
      if (this.trust === next) this.trust = prior;
      session.channel.close();
      throw error;
    }
    if (this.trust !== next || this.sessions.get(session.id) !== session) return;
    session.code = undefined;
    clearTimeout(session.deadline);
    this.notify();
  }

  private async dispatch(
    session: Session,
    message: Extract<WireMessage, { type: 'request' }>,
  ): Promise<void> {
    const { op, args, id } = message;
    try {
      let value: unknown;
      if (op === 'status') value = validateStatus(await this.options.operations.status());
      else if (op === 'launch') {
        const launched: unknown = await this.options.operations.launch(Number(args.projectId));
        if (
          !launched ||
          typeof launched !== 'object' ||
          !('shellIndex' in launched) ||
          !Number.isSafeInteger(launched.shellIndex) ||
          Number(launched.shellIndex) < 0 ||
          Number(launched.shellIndex) > 1_000_000
        )
          throw new Error('Invalid fleet launch result');
        value = { shellIndex: Number(launched.shellIndex) };
      } else if (op === 'stop') {
        await this.options.operations.stop(Number(args.projectId), Number(args.shellIndex));
        value = { ok: true };
      } else if (op === 'write') {
        await this.options.operations.write(
          Number(args.projectId),
          Number(args.shellIndex),
          String(args.data),
        );
        value = { ok: true };
      } else
        value = validateSnapshot(
          await this.options.operations.snapshot(Number(args.projectId), Number(args.shellIndex)),
        );
      if (value === null) throw new Error('Invalid fleet operation result');
      if (
        this.sessions.get(session.id) !== session ||
        !this.trust.trusted.some((peer) => peer.id === session.id) ||
        this.trust.revoked.includes(session.id)
      )
        return;
      session.channel.send({ type: 'response', id, ok: true, value });
    } catch {
      if (this.sessions.get(session.id) === session && !this.trust.revoked.includes(session.id))
        session.channel.send({ type: 'response', id, ok: false });
    }
  }

  /** Opens a time-bound TLS pairing session to a discovered certificate identity. */
  async pair(peerId: string): Promise<void> {
    if (
      !this.trust.enabled ||
      !ID.test(peerId) ||
      this.trust.revoked.includes(peerId) ||
      this.trust.trusted.some((peer) => peer.id === peerId)
    )
      throw new Error('Peer not available for pairing');
    const peer = this.presence.find((item) => item.id === peerId);
    if (!peer) throw new Error('Peer not discovered');
    if (this.sessions.has(peerId)) return;
    await this.dial(peer);
  }

  /** Accepts a link only when the locally entered code matches this TLS session's comparison code. */
  async approve(peerId: string, verificationCode: string): Promise<void> {
    const session = this.sessions.get(peerId);
    if (!this.trust.enabled || !session?.code || !/^\d{4}-\d{4}-\d{4}$/.test(verificationCode))
      throw new Error('No active pairing');
    if (verificationCode !== session.code || session.approvedLocal || !session.remoteHelloId)
      throw new Error('Verification code mismatch');
    session.approvedLocal = true;
    session.channel.send({
      type: 'approve',
      id: session.helloId,
      nonce: session.remoteNonce ?? '',
    });
    await this.finishPair(session);
  }

  /** Cancels an unfinished pairing or disconnects and persistently revokes an established link. */
  async revoke(peerId: string): Promise<void> {
    if (!ID.test(peerId)) throw new Error('Invalid peer identity');
    if (this.sessions.has(peerId) && !this.trust.trusted.some((peer) => peer.id === peerId)) {
      this.sessions.get(peerId)?.channel.close();
      this.notify();
      return;
    }
    const old = this.trust;
    const next: FleetTrust = {
      ...old,
      trusted: old.trusted.filter((peer) => peer.id !== peerId),
      revoked: old.revoked.includes(peerId) ? old.revoked : [...old.revoked, peerId],
    };
    this.trust = next;
    this.sessions.get(peerId)?.channel.close();
    try {
      await this.store.save(next);
    } catch (error) {
      this.trust = old;
      throw error;
    }
    this.notify();
  }

  private linked(peerId: string): FleetChannel {
    const session = this.sessions.get(peerId);
    if (
      !this.trust.enabled ||
      !this.trust.trusted.some((peer) => peer.id === peerId) ||
      this.trust.revoked.includes(peerId) ||
      !session?.remoteNonce
    )
      throw new Error('Peer is not linked and online');
    return session.channel;
  }

  /** Returns bounded projects and shell status from a linked, online peer. */
  async status(peerId: string): Promise<FleetStatus> {
    const result = validateStatus(await this.linked(peerId).request('status', {}));
    if (!result) throw new Error('Invalid peer status');
    return result;
  }

  /** Launches a shell through the peer's existing local shell policy. */
  async launch(peerId: string, projectId: number): Promise<{ shellIndex: number }> {
    if (!Number.isSafeInteger(projectId) || projectId < 1) throw new Error('Invalid project ID');
    const value = await this.linked(peerId).request('launch', { projectId });
    if (
      !value ||
      typeof value !== 'object' ||
      !('shellIndex' in value) ||
      !Number.isSafeInteger(value.shellIndex) ||
      Number(value.shellIndex) < 0
    )
      throw new Error('Invalid peer shell');
    return { shellIndex: Number(value.shellIndex) };
  }

  /** Stops an authorized live peer shell. */
  async stopShell(peerId: string, projectId: number, shellIndex: number): Promise<void> {
    this.validateShell(projectId, shellIndex);
    await this.linked(peerId).request('stop', { projectId, shellIndex });
  }

  /** Sends bounded terminal input only to an authorized live peer shell. */
  async write(peerId: string, projectId: number, shellIndex: number, data: string): Promise<void> {
    this.validateShell(projectId, shellIndex);
    if (typeof data !== 'string' || !data || Buffer.byteLength(data) > 8192)
      throw new Error('Invalid shell input');
    await this.linked(peerId).request('write', { projectId, shellIndex, data });
  }

  /** Returns bounded recent output from an authorized live peer shell. */
  async snapshot(
    peerId: string,
    projectId: number,
    shellIndex: number,
  ): Promise<{ output: string; alive: boolean }> {
    this.validateShell(projectId, shellIndex);
    const result = validateSnapshot(
      await this.linked(peerId).request('snapshot', { projectId, shellIndex }),
    );
    if (!result) throw new Error('Invalid peer output');
    return result;
  }

  private validateShell(projectId: number, shellIndex: number): void {
    if (
      !Number.isSafeInteger(projectId) ||
      projectId < 1 ||
      !Number.isSafeInteger(shellIndex) ||
      shellIndex < 0
    )
      throw new Error('Invalid shell identity');
  }
}
