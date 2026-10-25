/** Opt-in fleet service authenticates TLS peers before exposing local shell callbacks. */
import type { Socket } from 'node:net';
import { randomBytes, X509Certificate } from 'node:crypto';
import { connect, createServer, type Server, type TLSSocket } from 'node:tls';
import log from 'electron-log/main';
import type { FleetGitStatus, FleetShellRef, FleetState, FleetStatus, FleetTerminalEvent } from '../../shared/fleet-contract';
import { FleetChannel, type FleetCloseReason } from './channel';
import { FleetDiscovery, type Presence } from './discovery';
import {
  FleetIdentityStore,
  FleetCredentialError,
  FleetIdentityMissingError,
  type FleetIdentity,
  type FleetKeychain,
  type FleetTrust,
} from './identity';
import {
  certificateIdentity,
  pairingCode,
  validateGitStatus,
  validateSnapshot,
  validateStatus,
  validNoticeBody,
  validateProfiles,
  validArgs,
  validateStatusPage,
  ROOT_PAGE_SIZE,
  STATUS_PAGE_SIZE,
  type NoticeKind,
  type StatusPage,
  type WireMessage,
} from './protocol';

/** Shell callbacks must invoke the existing local IPC handlers and preserve local launch policy. */
export interface FleetOperations {
  readonly status: () => Promise<FleetStatus> | FleetStatus;
  readonly launch: (projectId: number) => Promise<{ shellIndex: number }>;
  readonly launchClaude: (projectId: number) => Promise<{ shellIndex: number }>;
  readonly profiles: (projectId: number) => Promise<{
    profiles: readonly { name: string; scope: 'project' | 'global'; icon?: string }[];
    defaultCliName: string | null;
  }>;
  readonly launchCli: (projectId: number, options: { profileName?: string; argv?: string[]; save?: boolean }) => Promise<{ shellIndex: number }>;
  readonly setDefaultCli: (projectId: number, name: string | null) => Promise<{ defaultCliName: string | null }>;
  readonly removeCliProfile: (projectId: number, name: string) => Promise<{ ok: true }>;
  readonly stop: (projectId: number, shellIndex: number) => Promise<void>;
  readonly write: (projectId: number, shellIndex: number, data: string) => Promise<void>;
  readonly resize: (projectId: number, shellIndex: number, cols: number, rows: number) => Promise<void>;
  readonly isAlive: (projectId: number, shellIndex: number) => boolean;
  readonly hasProject: (projectId: number) => boolean;
  readonly watch: (projectId: number, shellIndex: number, onData: (data: string) => void, onExit: () => void) => () => void;
  readonly terminalSnapshot: (projectId: number, shellIndex: number) => Promise<string>;
  readonly snapshot: (
    projectId: number,
    shellIndex: number,
  ) => Promise<{ output: string; alive: boolean }>;
  readonly gitStatus: (projectId: number) => Promise<FleetGitStatus>;
}
/** A Claude notice from a trusted host for a shell this controller subscribes to; names are resolved locally. */
export interface FleetNoticeEvent {
  readonly peerId: string;
  readonly peerName: string;
  readonly projectId: number;
  readonly projectName: string | null;
  readonly shellIndex: number;
  readonly kind: NoticeKind;
  readonly body: string;
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
interface TerminalSubscription {
  readonly id: string;
  readonly projectId: number;
  readonly shellIndex: number;
  unsubscribe: () => void;
  snapshot: string | null;
  offset: number;
  ready: boolean;
  exited: boolean;
  readonly pending: WireMessage[];
  pendingBytes: number;
  deadline?: NodeJS.Timeout;
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
    { status: FleetStatus; expires: number; rootOffset: number; projectOffset: number; shellOffset: number }
  >;
  statusPending: number;
  readonly incoming: Map<string, TerminalSubscription>;
  readonly outgoing: Map<string, { projectId: number; shellIndex: number }>;
  streamTimer?: NodeJS.Timeout;
  streamCursor: number;
}
const ID = /^[a-f0-9]{64}$/;
const GENERIC_FAILURE =
  'Fleet network unavailable. Check the local network and credential store, then disable and re-enable fleet.';
const CREDENTIAL_FAILURE =
  'Fleet identity in the credential store is unreadable. Reset identity to create a new one; paired devices must pair again.';
const MISSING_IDENTITY_FAILURE =
  'Fleet identity is missing from the credential store. Reset identity to create a new one; paired devices must pair again.';

/** Raised when the TLS listener cannot bind because another process already holds the port. */
class FleetPortInUseError extends Error {
  constructor(port: number, options?: ErrorOptions) {
    super(`Fleet port ${port} is already in use`, options);
    this.name = 'FleetPortInUseError';
  }
}

/** True for a project ID of 1..1,000,000 and a shell index of 0..1,000,000. */
function validShell(projectId: number, shellIndex: number): boolean {
  return Number.isSafeInteger(projectId) && projectId >= 1 && projectId <= 1_000_000 &&
    Number.isSafeInteger(shellIndex) && shellIndex >= 0 && shellIndex <= 1_000_000;
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
  private readonly terminalListeners = new Set<(event: FleetTerminalEvent) => void>();
  private readonly noticeListeners = new Set<(event: FleetNoticeEvent) => void>();
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
  private readonly lastStatus = new Map<string, FleetStatus>();
  private viewed: FleetShellRef | null = null;
  private fleetLog(event: string, reason: string, peerId?: string): void {
    const peer = peerId && ID.test(peerId) ? peerId : 'anonymous';
    log.info(`[fleet] ${event} reason=${reason} peer=${peer}`);
  }

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
      await this.closeNetwork('stop');
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

  /** Returns trusted peer identities and active local shell controllers without terminal content. */
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
    const controls: FleetState['controls'][number][] = [];
    for (const session of this.sessions.values()) {
      if (!this.trust.enabled || !this.started || !session.remoteNonce || session.code ||
        this.trust.revoked.includes(session.id)) continue;
      const peerName = this.trust.trusted.find((peer) => peer.id === session.id)?.name;
      if (!peerName) continue;
      for (const { projectId, shellIndex, exited } of session.incoming.values())
        if (!exited) controls.push({ projectId, shellIndex, peerName });
    }
    return {
      enabled: this.trust.enabled && this.started,
      peers,
      port: this.options.getPort?.() ?? 0,
      controls,
      ...(this.networkError ? { error: this.networkError } : {}),
      ...(this.recovery ? { recovery: this.recovery } : {}),
    };
  }

  private recordFailure(error: unknown, generic: string): void {
    const unreadable = error instanceof FleetCredentialError;
    const missing = error instanceof FleetIdentityMissingError;
    this.recovery = unreadable || missing ? 'reset-identity' : null;
    this.networkError = unreadable
      ? CREDENTIAL_FAILURE
      : missing
        ? MISSING_IDENTITY_FAILURE
        : error instanceof FleetPortInUseError
          ? error.message
          : generic;
    this.fleetLog('network-failed', unreadable || missing ? 'credential-store' :
      error instanceof FleetPortInUseError ? 'listen' : 'unknown');
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
        await this.closeNetwork('port-change');
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

  /** Replaces an unreadable or missing identity with a fresh one, clearing trusted peers but keeping revocations; only allowed in the reset-identity recovery state. */
  resetIdentity(): Promise<FleetState> {
    return this.runLifecycle(async () => {
      if (this.recovery !== 'reset-identity')
        throw new Error('Fleet identity reset is not available');
      await this.closeNetwork('identity-reset');
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
  /** Observes only terminal events from live authenticated subscriptions. */
  onTerminal(listener: (event: FleetTerminalEvent) => void): () => void {
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
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
      } else await this.closeNetwork('disable');
      this.fleetLog(enabled ? 'network-enabled' : 'network-disabled',
        enabled ? 'enable' : 'disable');
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
    await this.closeNetwork('trust-failure');
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

  private async closeNetwork(reason: 'stop' | 'disable' | 'port-change' | 'identity-reset' |
    'trust-failure' | 'network-failure' = 'network-failure'): Promise<void> {
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
    if (server) this.fleetLog('network-closed', reason);
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
    this.fleetLog('listener-opening', 'listen');
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
      this.fleetLog('listener-ready', 'listen');
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
        if (this.discovery === discovery) {
          this.fleetLog('discovery-failed', 'discovery');
          this.networkFailed();
        }
      },
    );
    this.discovery = discovery;
    await discovery.start(address.port);
    this.fleetLog('discovery-ready', 'discovery');
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
      this.fleetLog('reconnect-attempt', 'scheduled', peer.id);
      void this.dial(peer).then(() => {
        this.fleetLog('reconnect-outcome', 'connected', peer.id);
      }, () => {
        this.fleetLog('reconnect-outcome', 'connect-failure', peer.id);
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
      this.fleetLog('dial-connected', 'tls-verified', peer.id);
    } catch (error) {
      this.fleetLog('dial-failed', error instanceof Error &&
        error.message === 'Peer TLS identity does not match discovery' ? 'tls-mismatch' :
          error instanceof Error && error.message === 'Fleet connection timeout' ? 'deadline' : 'connect-failure',
      peer.id);
      throw error;
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
      if (expected) this.fleetLog('dial-rejected', !id || id !== expected ? 'tls-mismatch' :
        this.trust.revoked.includes(id) ? 'revoked' : 'self', expected);
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
      incoming: new Map(),
      outgoing: new Map(),
      streamCursor: 0,
      statusPending: 0,
    };
    this.sessions.set(id, session);
    replaced?.channel.close();
    if (replaced) this.fleetLog('session-replaced', 'replacement', id);
    channel.onDeadline(() => this.fleetLog('request-expired', 'deadline', id));
    channel.onClose((reason: FleetCloseReason) => {
      this.fleetLog('channel-closed', reason, id);
      this.clearSessionStreams(session);
      clearTimeout(session.deadline);
      if (this.sessions.get(id) === session) {
        this.sessions.delete(id);
        this.notify();
      }
    });
    channel.onMessage((message) => {
      void this.handle(session, message).catch(() => {
        channel.close('local');
      });
    });
    session.deadline = setTimeout(() => {
      if (session.code || !this.trust.trusted.some((peer) => peer.id === id))
        channel.close('deadline');
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
      session.channel.close('local');
      return;
    }
    if (message.type === 'hello') {
      if (session.remoteNonce || message.nonce === session.localNonce) {
        session.channel.close('protocol');
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
      if (session.code) this.fleetLog('pairing-pending', 'two-sided-consent', session.id);
      else this.fleetLog('peer-linked', 'trusted', session.id);
      this.notify();
      return;
    }
    if (!session.remoteNonce) {
      session.channel.close('protocol');
      return;
    }
    if (message.type === 'approve') {
      if (
        !session.code ||
        message.id !== session.remoteHelloId ||
        message.nonce !== session.localNonce ||
        session.approvedRemote
      ) {
        session.channel.close('protocol');
        return;
      }
      session.approvedRemote = true;
      await this.finishPair(session);
      return;
    }
    if (message.type === 'terminal') {
      this.forwardTerminal(session, message);
      return;
    }
    if (message.type === 'notice') {
      this.forwardNotice(session, message);
      return;
    }
    if (message.type !== 'request') {
      session.channel.close('protocol');
      return;
    }
    if (session.pairSaving) {
      try {
        await session.pairSaving;
      } catch {
        session.channel.close('local');
        return;
      }
    }
    if (
      this.sessions.get(session.id) !== session ||
      !this.trust.enabled ||
      this.trust.revoked.includes(session.id) ||
      !this.trust.trusted.some((peer) => peer.id === session.id)
    ) {
      session.channel.close('protocol');
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
      session.channel.close('local');
      this.fleetLog('pairing-failed', 'trust-save', session.id);
      throw error;
    }
    session.pairSaving = undefined;
    if (this.trust !== next || this.sessions.get(session.id) !== session) return;
    session.code = undefined;
    clearTimeout(session.deadline);
    this.fleetLog('pairing-approved', 'trust-saved', session.id);
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
      else if (op === 'git-status') value = validateGitStatus(await this.options.operations.gitStatus(Number(args.projectId)));
      else if (op === 'profiles' || op === 'set-default-cli' || op === 'remove-cli-profile' ||
        op === 'launch' || op === 'launch-claude' || op === 'launch-cli')
        value = await this.projectRequest(op, args);
      else if (op === 'subscribe') {
        value = this.acceptSubscription(session, Number(args.projectId), Number(args.shellIndex), String(args.subscriptionId));
      } else if (op === 'unsubscribe') {
        if (!session.incoming.has(String(args.subscriptionId))) throw new Error('Unknown subscription');
        this.removeSubscription(session, String(args.subscriptionId));
        value = { ok: true };
      } else if (op === 'resize') {
        const projectId = Number(args.projectId);
        const shellIndex = Number(args.shellIndex);
        if (!this.controlsShell(session, projectId, shellIndex) ||
          !this.options.operations.isAlive(projectId, shellIndex))
          throw new Error('Shell unavailable');
        await this.options.operations.resize(projectId, shellIndex, Number(args.cols), Number(args.rows));
        value = { ok: true };
      } else if (op === 'stop') {
        await this.options.operations.stop(Number(args.projectId), Number(args.shellIndex));
        value = { ok: true };
      } else if (op === 'write') {
        if (!this.options.operations.isAlive(Number(args.projectId), Number(args.shellIndex)))
          throw new Error('Shell unavailable');
        await this.options.operations.write(Number(args.projectId), Number(args.shellIndex), String(args.data));
        value = { ok: true };
      } else
        value = validateSnapshot(await this.options.operations.snapshot(Number(args.projectId), Number(args.shellIndex)));
      if (value === null) throw new Error('Invalid fleet operation result');
      if (this.sessions.get(session.id) !== session ||
        !this.trust.trusted.some((peer) => peer.id === session.id) ||
        this.trust.revoked.includes(session.id)) {
        if (op === 'subscribe') this.removeSubscription(session, String(args.subscriptionId));
        return;
      }
      session.channel.send({ type: 'response', id, ok: true, value });
    } catch (error) {
      if (op === 'subscribe') this.removeSubscription(session, String(args.subscriptionId));
      const safeError = op === 'launch-claude' ? this.launchFailure(error) : undefined;
      if (this.sessions.get(session.id) === session && !this.trust.revoked.includes(session.id))
        session.channel.send({ type: 'response', id, ok: false,
          ...(safeError ? { error: safeError } : {}) });
    }
  }
  private async projectRequest(
    op: 'profiles' | 'set-default-cli' | 'remove-cli-profile' | 'launch' | 'launch-claude' | 'launch-cli',
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const projectId = Number(args.projectId);
    if (op === 'profiles') return validateProfiles(await this.options.operations.profiles(projectId));
    if (op === 'set-default-cli') {
      const result = await this.options.operations.setDefaultCli(projectId, args.name as string | null);
      if (!result || !Object.hasOwn(result, 'defaultCliName') ||
        !validArgs('set-default-cli', { projectId, name: result.defaultCliName }))
        throw new Error('Invalid fleet default');
      return { defaultCliName: result.defaultCliName };
    }
    if (op === 'remove-cli-profile') {
      const result = await this.options.operations.removeCliProfile(projectId, String(args.name));
      if (!result || result.ok !== true) throw new Error('Invalid fleet removal');
      return { ok: true };
    }
    const launched: unknown = op === 'launch'
      ? await this.options.operations.launch(projectId)
      : op === 'launch-claude'
        ? await this.options.operations.launchClaude(projectId)
        : await this.options.operations.launchCli(projectId, {
          ...(typeof args.profileName === 'string' ? { profileName: args.profileName } : {}),
          ...(Array.isArray(args.argv) ? { argv: args.argv as string[] } : {}),
          ...(typeof args.save === 'boolean' ? { save: args.save } : {}),
        });
    if (!launched || typeof launched !== 'object' || !('shellIndex' in launched) ||
      !Number.isSafeInteger(launched.shellIndex) || Number(launched.shellIndex) < 0 ||
      Number(launched.shellIndex) > 1_000_000)
      throw new Error('Invalid fleet launch result');
    return { shellIndex: Number(launched.shellIndex) };
  }

  private launchFailure(error: unknown): 'permission-mode' | 'claude-missing' | 'shell-cap' | 'project-unavailable' | undefined {
    if (!(error instanceof Error)) return undefined;
    if (error.message === 'Choose a Claude permission mode first') return 'permission-mode';
    if (error.message === 'all shells are pinned — unpin one or raise cap') return 'shell-cap';
    if (/^no project \d+$|^Project folder no longer exists at /i.test(error.message))
      return 'project-unavailable';
    if (/(?:ENOENT|not found|not recognized|no such file)/i.test(error.message) &&
      /(?:claude|spawn)/i.test(error.message)) return 'claude-missing';
    return undefined;
  }

  private clearSessionStreams(session: Session): void {
    clearInterval(session.streamTimer);
    session.streamTimer = undefined;
    for (const id of session.incoming.keys()) this.removeSubscription(session, id);
    session.outgoing.clear();
  }

  private controlsShell(session: Session, projectId: number, shellIndex: number): boolean {
    for (const subscription of session.incoming.values())
      if (!subscription.exited &&
        subscription.projectId === projectId && subscription.shellIndex === shellIndex) return true;
    return false;
  }

  /** Reports whether a live remote controller owns this local PTY's dimensions. */
  isRemotelyControlled(projectId: number, shellIndex: number): boolean {
    if (!this.started || !this.trust.enabled) return false;
    for (const session of this.sessions.values())
      if (session.remoteNonce && !session.code &&
        this.trust.trusted.some((peer) => peer.id === session.id) &&
        this.controlsShell(session, projectId, shellIndex)) return true;
    return false;
  }
  private removeSubscription(session: Session, id: string): void {
    const subscription = session.incoming.get(id);
    if (!subscription) return;
    clearTimeout(subscription.deadline);
    session.incoming.delete(id);
    subscription.pending.length = 0;
    subscription.unsubscribe();
    this.notify();
    if (session.incoming.size === 0) {
      clearInterval(session.streamTimer);
      session.streamTimer = undefined;
    }
  }

  private queueOutput(session: Session, subscription: TerminalSubscription, kind: 'data' | 'exit', data: string): void {
    if (session.incoming.get(subscription.id) !== subscription) return;
    if (subscription.pendingBytes + Buffer.byteLength(data, 'utf8') > 262_144) {
      session.channel.close('pressure');
      return;
    }
    for (let offset = 0; offset < data.length;) {
      const end = this.chunkEnd(data, offset);
      const chunk = data.slice(offset, end);
      subscription.pending.push({ type: 'terminal', id: subscription.id, projectId: subscription.projectId,
        shellIndex: subscription.shellIndex, kind: 'data', data: chunk });
      subscription.pendingBytes += Buffer.byteLength(chunk, 'utf8');
      offset = end;
    }
    if (kind === 'exit') {
      subscription.exited = true;
      this.notify();
      subscription.pending.push({ type: 'terminal', id: subscription.id,
        projectId: subscription.projectId, shellIndex: subscription.shellIndex, kind: 'exit', data: '' });
    }
  }

  private chunkEnd(data: string, offset: number): number {
    let end = Math.min(offset + 2048, data.length);
    while (Buffer.byteLength(data.slice(offset, end), 'utf8') > 4096)
      end = offset + Math.floor((end - offset) / 2);
    if (end < data.length && end > offset && data.charCodeAt(end - 1) >= 0xd800 &&
      data.charCodeAt(end - 1) <= 0xdbff) end--;
    return end;
  }

  private failSubscription(session: Session, subscription: TerminalSubscription): void {
    if (session.incoming.get(subscription.id) !== subscription) return;
    this.removeSubscription(session, subscription.id);
    if (this.sessions.get(session.id) !== session || !this.trust.enabled ||
      this.trust.revoked.includes(session.id)) return;
    try {
      session.channel.send({ type: 'terminal', id: subscription.id,
        projectId: subscription.projectId, shellIndex: subscription.shellIndex, kind: 'exit', data: '' });
    } catch {
      session.channel.close();
    }
  }

  private acceptSubscription(session: Session, projectId: number, shellIndex: number, id: string): { subscriptionId: string } {
    if (session.incoming.size >= 4 || session.incoming.has(id) ||
      this.isRemotelyControlled(projectId, shellIndex) ||
      !this.options.operations.hasProject(projectId) ||
      !this.options.operations.isAlive(projectId, shellIndex))
      throw new Error('Shell unavailable');
    const snapshot = this.options.operations.terminalSnapshot(projectId, shellIndex);
    const subscription: TerminalSubscription = {
      id, projectId, shellIndex, unsubscribe: () => {}, snapshot: null,
      offset: 0, ready: false, exited: false, pending: [], pendingBytes: 0,
    };
    session.incoming.set(id, subscription);
    this.notify();
    const unsubscribe = this.options.operations.watch(projectId, shellIndex,
      (data) => this.queueOutput(session, subscription, 'data', data),
      () => this.queueOutput(session, subscription, 'exit', ''));
    subscription.unsubscribe = unsubscribe;
    subscription.deadline = setTimeout(() => this.failSubscription(session, subscription), 10_000);
    void snapshot.then((output) => {
      if (session.incoming.get(id) !== subscription) return;
      clearTimeout(subscription.deadline);
      if (Buffer.byteLength(output, 'utf8') > 4_194_304)
        this.failSubscription(session, subscription);
      else subscription.snapshot = output;
    }, () => this.failSubscription(session, subscription));
    session.streamTimer ??= setInterval(() => this.drainStreams(session), 20);
    return { subscriptionId: id };
  }

  private drainStreams(session: Session): void {
    if (this.sessions.get(session.id) !== session || !this.trust.enabled ||
      this.trust.revoked.includes(session.id)) {
      session.channel.close();
      return;
    }
    const count = session.incoming.size;
    if (count === 0) return;
    const slot = session.streamCursor++ % count;
    const subscribers = session.incoming.values();
    for (let index = 0; index < slot; index++) subscribers.next();
    const subscription = subscribers.next().value;
    if (!subscription || subscription.snapshot === null) return;
    let frame: WireMessage;
    if (subscription.offset < subscription.snapshot.length) {
      const end = this.chunkEnd(subscription.snapshot, subscription.offset);
      frame = { type: 'terminal', id: subscription.id, projectId: subscription.projectId,
        shellIndex: subscription.shellIndex, kind: 'snapshot',
        data: subscription.snapshot.slice(subscription.offset, end) };
      subscription.offset = end;
      if (end === subscription.snapshot.length) subscription.snapshot = '';
    } else if (!subscription.ready) {
      subscription.ready = true;
      frame = { type: 'terminal', id: subscription.id, projectId: subscription.projectId,
        shellIndex: subscription.shellIndex, kind: 'ready', data: '' };
    } else {
      const pending = subscription.pending.shift();
      if (!pending) return;
      frame = pending;
      if (pending.type === 'terminal') subscription.pendingBytes -= Buffer.byteLength(pending.data, 'utf8');
    }
    try {
      session.channel.send(frame);
      if (frame.type === 'terminal' && frame.kind === 'exit') this.removeSubscription(session, subscription.id);
    } catch {
      session.channel.close();
    }
  }

  private forwardTerminal(session: Session, frame: Extract<WireMessage, { type: 'terminal' }>): void {
    const subscription = session.outgoing.get(frame.id);
    if (!subscription || subscription.projectId !== frame.projectId ||
      subscription.shellIndex !== frame.shellIndex ||
      this.sessions.get(session.id) !== session ||
      !this.trust.enabled || this.trust.revoked.includes(session.id) ||
      !this.trust.trusted.some((peer) => peer.id === session.id)) return;
    if (frame.kind === 'exit') session.outgoing.delete(frame.id);
    const event: FleetTerminalEvent = { peerId: session.id, subscriptionId: frame.id,
      projectId: frame.projectId, shellIndex: frame.shellIndex, kind: frame.kind, data: frame.data };
    for (const listener of this.terminalListeners) listener(event);
  }

  private forwardNotice(session: Session, frame: Extract<WireMessage, { type: 'notice' }>): void {
    const peerName = this.trust.trusted.find((peer) => peer.id === session.id)?.name;
    if (!peerName || !this.trust.enabled || !this.trustedSession(session) ||
      ![...session.outgoing.values()].some((subscription) =>
        subscription.projectId === frame.projectId && subscription.shellIndex === frame.shellIndex)) return;
    const projectName = this.lastStatus.get(session.id)?.projects
      .find((project) => project.id === frame.projectId)?.name ?? null;
    const event: FleetNoticeEvent = { peerId: session.id, peerName, projectId: frame.projectId, projectName,
      shellIndex: frame.shellIndex, kind: frame.kind, body: frame.body };
    for (const listener of this.noticeListeners) listener(event);
  }

  private trustedSession(session: Session): boolean {
    return this.sessions.get(session.id) === session && !!session.remoteNonce && !session.code &&
      !this.trust.revoked.includes(session.id) && this.trust.trusted.some((peer) => peer.id === session.id);
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
        rootOffset: 0,
        projectOffset: 0,
        shellOffset: 0,
      });
      return { status, token };
    } finally {
      session.statusPending--;
    }
  }

  private async statusPage(session: Session, args: Record<string, unknown>): Promise<StatusPage> {
    const rootOffset = Number(args.rootOffset);
    const projectOffset = Number(args.projectOffset);
    const shellOffset = Number(args.shellOffset);
    const now = Date.now();
    for (const [token, snapshot] of session.statusSnapshots)
      if (snapshot.expires <= now) session.statusSnapshots.delete(token);
    let token: string;
    let status: FleetStatus;
    if (rootOffset === 0 && projectOffset === 0 && shellOffset === 0) {
      ({ status, token } = await this.captureStatus(session));
    } else {
      token = String(args.token);
      const snapshot = session.statusSnapshots.get(token);
      if (
        !snapshot ||
        snapshot.expires <= now ||
        snapshot.projectOffset !== projectOffset ||
        snapshot.rootOffset !== rootOffset ||
        snapshot.shellOffset !== shellOffset
      )
        throw new Error('Invalid fleet status offset');
      status = snapshot.status;
      snapshot.expires = now + 10_000;
    }
    if (rootOffset > status.roots.length ||
      projectOffset > status.projects.length || shellOffset > status.shells.length)
      throw new Error('Invalid fleet status offset');
    const page: StatusPage = {
      roots: status.roots.slice(rootOffset, rootOffset + ROOT_PAGE_SIZE),
      projects: status.projects.slice(projectOffset, projectOffset + STATUS_PAGE_SIZE),
      shells: status.shells.slice(shellOffset, shellOffset + STATUS_PAGE_SIZE),
      rootOffset,
      projectOffset,
      shellOffset,
      rootTotal: status.roots.length,
      projectTotal: status.projects.length,
      shellTotal: status.shells.length,
      token,
    };
    const snapshot = session.statusSnapshots.get(token);
    if (snapshot) {
      snapshot.rootOffset = rootOffset + page.roots.length;
      snapshot.projectOffset = projectOffset + page.projects.length;
      snapshot.shellOffset = shellOffset + page.shells.length;
    }
    if (
      rootOffset + page.roots.length === page.rootTotal &&
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
        this.fleetLog('pairing-cancelled', 'revoke', peerId);
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
      this.fleetLog('peer-unlinked', 'revoke', peerId);
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

  /** Returns the complete bounded root, project, and shell hierarchy of a linked peer. */
  async status(peerId: string): Promise<FleetStatus> {
    const channel = this.linked(peerId);
    const roots: FleetStatus['roots'][number][] = [];
    const projects: FleetStatus['projects'][number][] = [];
    const shells: FleetStatus['shells'][number][] = [];
    let token: string | undefined;
    let rootTotal: number | undefined;
    let projectTotal: number | undefined;
    let shellTotal: number | undefined;
    do {
      if (this.linked(peerId) !== channel) throw new Error('Fleet peer changed during status');
      const args = token
        ? { rootOffset: roots.length, projectOffset: projects.length, shellOffset: shells.length, token }
        : { rootOffset: 0, projectOffset: 0, shellOffset: 0 };
      const page = validateStatusPage(await channel.request('status', args));
      if (
        !page ||
        page.rootOffset !== roots.length ||
        page.projectOffset !== projects.length ||
        page.shellOffset !== shells.length ||
        (token && page.token !== token) ||
        (rootTotal !== undefined && page.rootTotal !== rootTotal) ||
        (projectTotal !== undefined && page.projectTotal !== projectTotal) ||
        (shellTotal !== undefined && page.shellTotal !== shellTotal)
      )
        throw new Error('Invalid peer status page');
      token = page.token;
      rootTotal = page.rootTotal;
      projectTotal = page.projectTotal;
      shellTotal = page.shellTotal;
      roots.push(...page.roots);
      projects.push(...page.projects);
      shells.push(...page.shells);
      if (roots.length < rootTotal)
        await new Promise<void>((resolve) => setTimeout(resolve, 12));
    } while (roots.length < rootTotal || projects.length < projectTotal || shells.length < shellTotal);
    if (this.linked(peerId) !== channel) throw new Error('Fleet peer changed during status');
    const status = validateStatus({ roots, projects, shells });
    if (!status) throw new Error('Invalid peer status');
    this.lastStatus.set(peerId, status);
    return status;
  }

  /** Launches a shell through the peer's existing local shell policy. */
  async launch(peerId: string, projectId: number): Promise<{ shellIndex: number }> {
    if (!Number.isSafeInteger(projectId) || projectId < 1 || projectId > 1_000_000)
      throw new Error('Invalid project ID');
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

  /** Launches or reattaches the peer's primary Claude shell under its own configuration. */
  async launchClaude(peerId: string, projectId: number): Promise<{ shellIndex: number }> {
    if (!Number.isSafeInteger(projectId) || projectId < 1 || projectId > 1_000_000)
      throw new Error('Invalid project ID');
    const value = await this.linked(peerId).request('launch-claude', { projectId });
    if (!value || typeof value !== 'object' || !('shellIndex' in value) ||
      !Number.isSafeInteger(value.shellIndex) || Number(value.shellIndex) < 0 ||
      Number(value.shellIndex) > 1_000_000) throw new Error('Invalid peer shell');
    return { shellIndex: Number(value.shellIndex) };
  }

  /** Lists only public profile labels and the saved project default of a linked peer. */
  async profiles(peerId: string, projectId: number): Promise<{
    profiles: readonly { name: string; scope: 'project' | 'global'; icon?: string }[];
    defaultCliName: string | null;
  }> {
    if (!validArgs('profiles', { projectId })) throw new Error('Invalid project ID');
    const result = validateProfiles(await this.linked(peerId).request('profiles', { projectId }));
    if (!result) throw new Error('Invalid peer profiles');
    return result;
  }

  /** Launches a remote saved profile or bounded custom command using its own environment and cap. */
  async launchCli(peerId: string, projectId: number,
    options: { profileName?: string; argv?: string[]; save?: boolean }): Promise<{ shellIndex: number }> {
    const args = { projectId, ...options };
    if (!validArgs('launch-cli', args)) throw new Error('Invalid CLI launch');
    const result = await this.linked(peerId).request('launch-cli', args);
    if (!result || typeof result !== 'object' || !('shellIndex' in result) ||
      !Number.isSafeInteger(result.shellIndex) || Number(result.shellIndex) < 0 ||
      Number(result.shellIndex) > 1_000_000) throw new Error('Invalid peer shell');
    return { shellIndex: Number(result.shellIndex) };
  }

  /** Updates the linked host's default only when its local catalog permits the name. */
  async setDefaultCli(peerId: string, projectId: number, name: string | null): Promise<{ defaultCliName: string | null }> {
    if (!validArgs('set-default-cli', { projectId, name })) throw new Error('Invalid CLI default');
    const value = await this.linked(peerId).request('set-default-cli', { projectId, name });
    if (!value || typeof value !== 'object' || !('defaultCliName' in value) ||
      (value.defaultCliName !== null && typeof value.defaultCliName !== 'string') ||
      !validArgs('set-default-cli', { projectId, name: value.defaultCliName }))
      throw new Error('Invalid peer default');
    return { defaultCliName: value.defaultCliName };
  }

  /** Removes a saved project profile on the linked host without exposing its configuration. */
  async removeCliProfile(peerId: string, projectId: number, name: string): Promise<{ ok: true }> {
    if (!validArgs('remove-cli-profile', { projectId, name })) throw new Error('Invalid CLI profile');
    const result = await this.linked(peerId).request('remove-cli-profile', { projectId, name });
    if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true)
      throw new Error('Invalid peer removal');
    return { ok: true };
  }

  /** Attaches to an existing remote PTY, with terminal events allowed before acknowledgement. */
  async subscribe(peerId: string, projectId: number, shellIndex: number): Promise<{ subscriptionId: string }> {
    this.validateShell(projectId, shellIndex);
    const channel = this.linked(peerId);
    const session = this.sessions.get(peerId);
    if (!session || session.channel !== channel || session.outgoing.size >= 4)
      throw new Error('Fleet subscription unavailable');
    const subscriptionId = randomBytes(16).toString('hex');
    session.outgoing.set(subscriptionId, { projectId, shellIndex });
    try {
      const result = await channel.request('subscribe', { projectId, shellIndex, subscriptionId });
      if (this.linked(peerId) !== channel || !result || typeof result !== 'object' ||
        !('subscriptionId' in result) || result.subscriptionId !== subscriptionId)
        throw new Error('Invalid peer subscription');
      return { subscriptionId };
    } catch (error) {
      session.outgoing.delete(subscriptionId);
      throw error;
    }
  }

  private confirmAck(value: unknown): void {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 1 || !('ok' in value) || value.ok !== true)
      throw new Error('Invalid peer acknowledgement');
  }

  /** Stops all renderer delivery for one session-scoped remote attachment. */
  async unsubscribe(peerId: string, subscriptionId: string): Promise<void> {
    const channel = this.linked(peerId);
    const session = this.sessions.get(peerId);
    if (!session || session.channel !== channel || !/^[a-f0-9]{32}$/.test(subscriptionId) ||
      !session.outgoing.delete(subscriptionId)) throw new Error('Unknown fleet subscription');
    this.confirmAck(await channel.request('unsubscribe', { subscriptionId }));
  }

  /** Resizes only an existing remote shell within terminal dimension bounds. */
  async resize(peerId: string, projectId: number, shellIndex: number, cols: number, rows: number): Promise<void> {
    this.validateShell(projectId, shellIndex);
    if (!Number.isSafeInteger(cols) || cols < 2 || cols > 500 ||
      !Number.isSafeInteger(rows) || rows < 2 || rows > 200)
      throw new Error('Invalid terminal dimensions');
    this.confirmAck(await this.linked(peerId).request('resize', { projectId, shellIndex, cols, rows }));
  }

  /** Stops an authorized live peer shell. */
  async stopShell(peerId: string, projectId: number, shellIndex: number): Promise<void> {
    this.validateShell(projectId, shellIndex);
    this.confirmAck(await this.linked(peerId).request('stop', { projectId, shellIndex }));
  }

  /** Sends bounded terminal input only to an authorized live peer shell. */
  async write(peerId: string, projectId: number, shellIndex: number, data: string): Promise<void> {
    this.validateShell(projectId, shellIndex);
    if (typeof data !== 'string' || !data || Buffer.byteLength(data) > 8192)
      throw new Error('Invalid shell input');
    this.confirmAck(await this.linked(peerId).request('write', { projectId, shellIndex, data }));
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
    if (!validShell(projectId, shellIndex)) throw new Error('Invalid shell identity');
  }

  /** Observes Claude notices from trusted hosts for shells this controller subscribes to. */
  onNotice(listener: (event: FleetNoticeEvent) => void): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  /** Sends a Claude notice to every trusted session controlling the shell; returns how many were sent. */
  sendNotice(notice: { projectId: number; shellIndex: number; kind: NoticeKind; body: string }): number {
    const { projectId, shellIndex, kind, body } = notice;
    if (!this.started || !this.trust.enabled || !validNoticeBody(body) ||
      (kind !== 'needs-input' && kind !== 'finished') || !validShell(projectId, shellIndex)) return 0;
    let sent = 0;
    for (const session of this.sessions.values()) {
      if (!this.trustedSession(session) || !this.controlsShell(session, projectId, shellIndex)) continue;
      try {
        session.channel.send({ type: 'notice', id: randomBytes(16).toString('hex'), projectId, shellIndex, kind, body });
        sent++;
      } catch {
        session.channel.close();
      }
    }
    return sent;
  }

  /** Reads the bounded git summary of a project the linked peer exposes. */
  async gitStatus(peerId: string, projectId: number): Promise<FleetGitStatus> {
    if (!validArgs('git-status', { projectId })) throw new Error('Invalid project ID');
    const result = validateGitStatus(await this.linked(peerId).request('git-status', { projectId }));
    if (!result) throw new Error('Invalid peer git status');
    return result;
  }

  /** Records the remote shell this window shows, or null. */
  setViewing(shell: FleetShellRef | null): void {
    this.viewed = shell ? { peerId: shell.peerId, projectId: shell.projectId, shellIndex: shell.shellIndex } : null;
  }

  /** The remote shell this window shows, or null. */
  viewing(): FleetShellRef | null {
    return this.viewed;
  }
}
