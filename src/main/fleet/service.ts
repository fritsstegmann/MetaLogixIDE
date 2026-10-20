/** Opt-in fleet service authenticates TLS peers before exposing local shell callbacks. */
import type { Socket } from 'node:net';
import { randomBytes, X509Certificate } from 'node:crypto';
import { connect, createServer, type Server, type TLSSocket } from 'node:tls';
import type { FleetState, FleetStatus } from '../../shared/fleet-contract';
import { FleetChannel } from './channel';
import { FleetDiscovery, type Presence } from './discovery';
import {
  FleetIdentityStore,
  FleetCredentialError,
  type FleetIdentity,
  type FleetKeychain,
  type FleetTrust,
} from './identity';
import {
  certificateIdentity,
  pairingCode,
  validateSnapshot,
  validateStatus,
  validateStatusPage,
  STATUS_PAGE_SIZE,
  type StatusPage,
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
  /** Current TCP listener port; defaults to 0 (ephemeral) so concurrent test services never collide. */
  readonly getPort?: () => number;
  /** Persists a validated port chosen through setPort. */
  readonly savePort?: (port: number) => void;
}
interface Session {
  readonly id: string;
  readonly channel: FleetChannel;
  readonly outbound: boolean;
  readonly localNonce: string;
  readonly helloId: string;
  remoteNonce?: string;
  remoteHelloId?: string;
  code?: string;
  approvedLocal: boolean;
  approvedRemote: boolean;
  pairSaving?: Promise<void>;
  deadline?: NodeJS.Timeout;
  readonly statusSnapshots: Map<
    string,
    { status: FleetStatus; expires: number; projectOffset: number; shellOffset: number }
  >;
  statusPending: number;
}
const ID = /^[a-f0-9]{64}$/;
const GENERIC_FAILURE =
  'Fleet network unavailable. Check the local network and credential store, then disable and re-enable fleet.';
const CREDENTIAL_FAILURE =
  'Fleet identity in the credential store is unreadable. Reset identity to create a new one; paired devices must pair again.';

/** Raised when the TLS listener cannot bind because another process already holds the port. */
class FleetPortInUseError extends Error {
  constructor(port: number, options?: ErrorOptions) {
    super(`Fleet port ${port} is already in use`, options);
    this.name = 'FleetPortInUseError';
  }
}

/** Accepts only integers 1024..65535 from untrusted input; anything else throws. */
export function parseFleetPort(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1024 || value > 65535)
    throw new Error('Fleet port must be an integer between 1024 and 65535');
  return value;
}

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
  private recovery: 'reset-identity' | null = null;
  private lifecycle: Promise<void> = Promise.resolve();

  constructor(private readonly options: FleetOptions) {
    if (!options.name.trim() || Buffer.byteLength(options.name, 'utf8') > 80)
      throw new Error('Invalid fleet machine name');
    this.store = new FleetIdentityStore(options.storageDir, options.keychain);
  }

  /** Loads persisted opt-in and starts network listeners only if enabled. */
  start(): Promise<void> {
    return this.runLifecycle(async () => {
      if (this.started) return;
      try {
        this.trust = await this.store.load();
        this.started = true;
        if (this.trust.enabled) await this.open();
        this.clearFailure();
      } catch (error) {
        this.started = true;
        this.recordFailure(error, GENERIC_FAILURE);
        await this.closeNetwork();
      }
      this.notify();
    });
  }

  /** Tears down transport, pending approvals and timers without changing saved opt-in. */
  stop(): Promise<void> {
    return this.runLifecycle(async () => {
      this.started = false;
      await this.closeNetwork();
      this.notify();
    });
  }

  private runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /** Returns only public peer identity before approval and never includes terminal content. */
  state(): FleetState {
    const peers = this.presence
      .filter((peer) => !this.trust.revoked.includes(peer.id))
      .map((peer) => {
        const session = this.sessions.get(peer.id);
        const linked = this.trust.trusted.some((item) => item.id === peer.id) && !session?.code;
        return {
          id: peer.id,
          name: linked
            ? (this.trust.trusted.find((item) => item.id === peer.id)?.name ?? peer.name)
            : peer.name,
          status: session?.code
            ? ('pending' as const)
            : linked && session?.remoteNonce
              ? ('linked' as const)
              : linked
                ? ('offline' as const)
                : ('discovered' as const),
          ...(session?.code ? { verificationCode: session.code } : {}),
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
      port: this.options.getPort?.() ?? 0,
      ...(this.networkError ? { error: this.networkError } : {}),
      ...(this.recovery ? { recovery: this.recovery } : {}),
    };
  }

  private recordFailure(error: unknown, generic: string): void {
    this.recovery = error instanceof FleetCredentialError ? 'reset-identity' : null;
    this.networkError =
      error instanceof FleetCredentialError
        ? CREDENTIAL_FAILURE
        : error instanceof FleetPortInUseError
          ? error.message
          : generic;
  }

  private clearFailure(): void {
    this.networkError = null;
    this.recovery = null;
  }

  /** Validates and persists a new listener port, then re-binds a running listener; a failed re-bind restores the old port. */
  setPort(value: unknown): Promise<FleetState> {
    return this.runLifecycle(async () => {
      const port = parseFleetPort(value);
      const prior = this.options.getPort?.() ?? 0;
      this.options.savePort?.(port);
      if (this.server) {
        await this.closeNetwork();
        try {
          await this.open();
        } catch (error) {
          this.options.savePort?.(prior);
          this.recordFailure(error, GENERIC_FAILURE);
          try {
            await this.open();
            this.clearFailure();
          } catch {
            await this.closeNetwork();
          }
          this.notify();
          throw error;
        }
      }
      this.notify();
      return this.state();
    });
  }

  /** Replaces an unreadable identity with a fresh one, clearing trusted peers but keeping revocations; only allowed in the reset-identity recovery state. */
  resetIdentity(): Promise<FleetState> {
    return this.runLifecycle(async () => {
      if (this.recovery !== 'reset-identity')
        throw new Error('Fleet identity reset is not available');
      await this.closeNetwork();
      await this.store.deleteIdentity();
      this.identity = await this.store.loadIdentity(false);
      const fresh: FleetTrust = { enabled: false, trusted: [], revoked: this.trust.revoked };
      try {
        await this.store.save(fresh);
      } catch (error) {
        return this.failClosed(error, fresh);
      }
      this.trust = fresh;
      this.clearFailure();
      this.notify();
      return this.state();
    });
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

  /** Persists opt-in before opening transport; disabling waits for earlier startup to finish. */
  setEnabled(enabled: boolean): Promise<FleetState> {
    return this.runLifecycle(async () => {
      if (!this.started) throw new Error('Fleet service not started');
      if (this.trust.enabled === enabled) return this.state();
      const prior = this.trust;
      const next = { ...prior, enabled };
      this.trust = next;
      try {
        await this.store.save(next);
      } catch (error) {
        if (!enabled) return this.failClosed(error, next);
        this.trust = prior;
        throw error;
      }
      if (enabled) {
        try {
          await this.open();
        } catch (error) {
          this.trust = prior;
          this.recordFailure(
            error,
            'Fleet network unavailable. Check the local network and credential store, then retry.',
          );
          await this.closeNetwork();
          try {
            await this.store.save(prior);
          } catch (saveError) {
            return this.failClosed(saveError, prior);
          }
          this.notify();
          throw error;
        }
      } else await this.closeNetwork();
      this.clearFailure();
      this.notify();
      return this.state();
    });
  }

  private async failClosed(error: unknown, trust: FleetTrust): Promise<never> {
    const safe: FleetTrust = { ...trust, enabled: false, trusted: [] };
    this.trust = safe;
    this.networkError =
      'Fleet trust unavailable. The network is closed; check fleet storage before enabling it again.';
    await this.closeNetwork();
    try {
      await this.store.save(safe);
    } catch (saveError) {
      try {
        this.store.invalidate();
      } catch (invalidateError) {
        this.notify();
        throw new AggregateError(
          [error, saveError, invalidateError],
          'Fleet trust cannot be secured on disk',
        );
      }
    }
    this.notify();
    throw error;
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
    const server = this.server;
    if (!server || !this.started || !this.trust.enabled) return;
    this.networkError =
      'Fleet network unavailable. Check the local network and firewall, then disable and re-enable fleet.';
    void this.runLifecycle(async () => {
      if (this.server !== server || !this.started || !this.trust.enabled) return;
      await this.closeNetwork();
      this.notify();
    });
  }

  private async open(): Promise<void> {
    if (this.server) return;
    const port = this.options.getPort?.() ?? 0;
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
        handshakeTimeout: 3_000,
      },
      (socket) => {
        try {
          this.accept(socket);
        } catch {
          socket.destroy();
        }
      },
    );
    this.guardPreAuth(server);
    server.maxConnections = 25;
    this.server = server;
    server.on('error', () => {
      if (this.server === server) this.networkFailed();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException): void => {
          reject(
            error.code === 'EADDRINUSE' ? new FleetPortInUseError(port, { cause: error }) : error,
          );
        };
        server.once('error', onError);
        server.listen(port, '0.0.0.0', () => {
          server.removeListener('error', onError);
          resolve();
        });
      });
      await this.startDiscovery(server, identity);
    } catch (error) {
      await this.closeNetwork();
      throw error;
    }
  }

  private guardPreAuth(server: Server): void {
    const preAuth = new Map<Socket, string>();
    server.on('connection', (socket: Socket) => {
      const address = socket.remoteAddress ?? '';
      let oldest: Socket | undefined;
      let oldestFromAddress: Socket | undefined;
      let sameAddress = 0;
      for (const [pending, origin] of preAuth) {
        if (pending.destroyed) {
          preAuth.delete(pending);
          continue;
        }
        oldest ??= pending;
        if (origin === address) {
          oldestFromAddress ??= pending;
          sameAddress++;
        }
      }
      if (sameAddress >= 2) oldestFromAddress?.destroy();
      else if (preAuth.size >= 8) oldest?.destroy();
      preAuth.set(socket, address);
      socket.setTimeout(3_000, () => socket.destroy());
      socket.once('close', () => preAuth.delete(socket));
    });
    server.on('secureConnection', (socket: TLSSocket) => {
      for (const [candidate, address] of preAuth) {
        if (address === socket.remoteAddress && candidate.remotePort === socket.remotePort) {
          candidate.setTimeout(0);
          preAuth.delete(candidate);
          break;
        }
      }
    });
  }

  private async startDiscovery(server: Server, identity: FleetIdentity): Promise<void> {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fleet listener unavailable');
    const discovery = new FleetDiscovery(
      identity.id,
      this.options.name,
      (peers) => {
        if (this.discovery !== discovery) return;
        this.presence = peers;
        this.notify();
        this.reconnect();
      },
      () => {
        if (this.discovery === discovery) this.networkFailed();
      },
    );
    this.discovery = discovery;
    await discovery.start(address.port);
    this.reconnectTimer = setInterval(() => {
      this.reconnect();
    }, 5000);
  }

  private reconnect(): void {
    if (!this.started || !this.identity || !this.trust.enabled) return;
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
    if (!this.started || !this.trust.enabled || !this.identity || this.sessions.has(peer.id))
      return;
    if (this.starting) {
      try {
        await this.starting;
      } catch {
        /* another peer's failure must not cancel this dial */
      }
      if (!this.started || !this.trust.enabled || this.sessions.has(peer.id)) return;
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
            if (this.accept(socket, peer.id)) {
              socket.setTimeout(0);
              socket.removeListener('timeout', onTimeout);
              resolve();
            } else reject(new Error('Peer TLS identity does not match discovery'));
          } catch (error) {
            socket.destroy();
            reject(error);
          }
        },
      );
      socket.once('error', reject);
      const onTimeout = () => {
        socket.destroy();
        reject(new Error('Fleet connection timeout'));
      };
      socket.once('timeout', onTimeout);
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
    if (!this.started || !this.trust.enabled || !this.identity) {
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
    if (this.sessions.size >= 16 && !this.sessions.has(id)) {
      socket.destroy();
      return false;
    }
    if (!this.limit(socket.remoteAddress ?? id)) {
      socket.destroy();
      return false;
    }
    const outbound = expected !== undefined;
    const existing = this.sessions.get(id);
    const preferredOutbound = this.identity.id < id;
    if (
      existing &&
      (existing.pairSaving ||
        existing.outbound === preferredOutbound ||
        outbound !== preferredOutbound)
    ) {
      socket.destroy();
      return true;
    }
    this.attachSession(socket, id, outbound);
    return true;
  }

  private attachSession(socket: TLSSocket, id: string, outbound: boolean): void {
    const replaced = this.sessions.get(id);
    socket.setKeepAlive(true, 10_000);
    const channel = new FleetChannel(socket);
    const session: Session = {
      outbound,
      id,
      channel,
      localNonce: randomBytes(32).toString('hex'),
      helloId: randomBytes(16).toString('hex'),
      approvedLocal: false,
      approvedRemote: false,
      statusSnapshots: new Map(),
      statusPending: 0,
    };
    this.sessions.set(id, session);
    replaced?.channel.close();
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
      if (session.code || !this.trust.trusted.some((peer) => peer.id === id)) channel.close();
    }, 90_000);
    channel.send({ type: 'hello', id: session.helloId, nonce: session.localNonce });
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
    if (message.type !== 'request') {
      session.channel.close();
      return;
    }
    if (session.pairSaving) {
      try {
        await session.pairSaving;
      } catch {
        session.channel.close();
        return;
      }
    }
    if (
      this.sessions.get(session.id) !== session ||
      !this.trust.enabled ||
      this.trust.revoked.includes(session.id) ||
      !this.trust.trusted.some((peer) => peer.id === session.id)
    ) {
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
    session.pairSaving = this.store.save(next);
    try {
      await session.pairSaving;
    } catch (error) {
      if (this.trust === next) this.trust = prior;
      session.channel.close();
      throw error;
    }
    session.pairSaving = undefined;
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
    let value: unknown;
    try {
      if (op === 'status') value = await this.statusPage(session, args);
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
  private async captureStatus(session: Session): Promise<{ status: FleetStatus; token: string }> {
    if (session.statusSnapshots.size + session.statusPending >= 4)
      throw new Error('Too many status snapshots');
    session.statusPending++;
    try {
      const status = validateStatus(await this.options.operations.status());
      if (!status) throw new Error('Invalid fleet status');
      const token = randomBytes(16).toString('hex');
      session.statusSnapshots.set(token, {
        status,
        expires: Date.now() + 10_000,
        projectOffset: 0,
        shellOffset: 0,
      });
      return { status, token };
    } finally {
      session.statusPending--;
    }
  }

  private async statusPage(session: Session, args: Record<string, unknown>): Promise<StatusPage> {
    const projectOffset = Number(args.projectOffset);
    const shellOffset = Number(args.shellOffset);
    const now = Date.now();
    for (const [token, snapshot] of session.statusSnapshots)
      if (snapshot.expires <= now) session.statusSnapshots.delete(token);
    let token: string;
    let status: FleetStatus;
    if (projectOffset === 0 && shellOffset === 0) {
      ({ status, token } = await this.captureStatus(session));
    } else {
      token = String(args.token);
      const snapshot = session.statusSnapshots.get(token);
      if (
        !snapshot ||
        snapshot.expires <= now ||
        snapshot.projectOffset !== projectOffset ||
        snapshot.shellOffset !== shellOffset
      )
        throw new Error('Invalid fleet status offset');
      status = snapshot.status;
      snapshot.expires = now + 10_000;
    }
    if (projectOffset > status.projects.length || shellOffset > status.shells.length)
      throw new Error('Invalid fleet status offset');
    const page: StatusPage = {
      projects: status.projects.slice(projectOffset, projectOffset + STATUS_PAGE_SIZE),
      shells: status.shells.slice(shellOffset, shellOffset + STATUS_PAGE_SIZE),
      projectOffset,
      shellOffset,
      projectTotal: status.projects.length,
      shellTotal: status.shells.length,
      token,
    };
    const snapshot = session.statusSnapshots.get(token);
    if (snapshot) {
      snapshot.projectOffset = projectOffset + page.projects.length;
      snapshot.shellOffset = shellOffset + page.shells.length;
    }
    if (
      projectOffset + page.projects.length === page.projectTotal &&
      shellOffset + page.shells.length === page.shellTotal
    )
      session.statusSnapshots.delete(token);
    return page;
  }

  /** Opens a time-bound TLS pairing session to a discovered certificate identity. */
  async pair(peerId: string): Promise<void> {
    if (
      !this.started ||
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

  /** Cancels unfinished pairing or persistently denies an established certificate. */
  revoke(peerId: string): Promise<void> {
    return this.runLifecycle(async () => {
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
        return this.failClosed(error, next);
      }
      this.notify();
    });
  }

  private linked(peerId: string): FleetChannel {
    const session = this.sessions.get(peerId);
    if (
      !this.trust.enabled ||
      !this.trust.trusted.some((peer) => peer.id === peerId) ||
      this.trust.revoked.includes(peerId) ||
      !session?.remoteNonce ||
      !!session.code
    )
      throw new Error('Peer is not linked and online');
    return session.channel;
  }

  /** Returns complete bounded projects and shell status from a linked, online peer. */
  async status(peerId: string): Promise<FleetStatus> {
    const channel = this.linked(peerId);
    const projects: FleetStatus['projects'][number][] = [];
    const shells: FleetStatus['shells'][number][] = [];
    let token: string | undefined;
    let projectTotal: number | undefined;
    let shellTotal: number | undefined;
    do {
      if (this.linked(peerId) !== channel) throw new Error('Fleet peer changed during status');
      const args = token
        ? { projectOffset: projects.length, shellOffset: shells.length, token }
        : { projectOffset: 0, shellOffset: 0 };
      const page = validateStatusPage(await channel.request('status', args));
      if (
        !page ||
        page.projectOffset !== projects.length ||
        page.shellOffset !== shells.length ||
        (token && page.token !== token) ||
        (projectTotal !== undefined && page.projectTotal !== projectTotal) ||
        (shellTotal !== undefined && page.shellTotal !== shellTotal)
      )
        throw new Error('Invalid peer status page');
      token = page.token;
      projectTotal = page.projectTotal;
      shellTotal = page.shellTotal;
      projects.push(...page.projects);
      shells.push(...page.shells);
    } while (projects.length < projectTotal || shells.length < shellTotal);
    if (this.linked(peerId) !== channel) throw new Error('Fleet peer changed during status');
    return { projects, shells };
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
