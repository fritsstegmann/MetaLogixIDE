/** Opt-in multicast presence with a strict public-only beacon and expiry. */
import { createSocket, type Socket, type RemoteInfo } from 'node:dgram';
import log from 'electron-log/main';
import { networkInterfaces } from 'node:os';
import { decodeBeacon, type Beacon } from './protocol';

const GROUP = '239.255.43.71';
const PORT = 43871;
export interface Presence {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly seen: number;
}

/** Publishes and receives LAN beacons while enabled; no project or credential data enters packets. */
export class FleetDiscovery {
  private socket: Socket | null = null;
  private timer: NodeJS.Timeout | undefined;
  private readonly peers = new Map<string, Presence>();
  private active = false;
  private readonly inbound = new Map<string, { since: number; count: number }>();
  constructor(
    private readonly identity: string,
    private readonly name: string,
    private readonly onChange: (peers: readonly Presence[]) => void,
    private readonly onError?: () => void,
  ) {}

  /** Binds multicast membership and starts bounded periodic announcements. */
  async start(port: number): Promise<void> {
    if (this.socket) return;
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('message', (bytes: Buffer, remote: RemoteInfo) => {
      this.observe(bytes, remote.address);
    });
    socket.on('error', () => {
      const wasActive = this.active;
      this.stop();
      if (wasActive) this.onError?.();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(PORT, '0.0.0.0', () => {
          socket.removeListener('error', reject);
          resolve();
        });
      });
      let joined = 0;
      for (const addresses of Object.values(networkInterfaces())) {
        for (const address of addresses ?? []) {
          if (address.family !== 'IPv4' || address.internal) continue;
          try {
            socket.addMembership(GROUP, address.address);
            joined++;
          } catch {
            /* another interface may allow membership */
          }
        }
      }
      if (joined === 0) throw new Error('LAN multicast unavailable');
      socket.setMulticastTTL(1);
      socket.setMulticastLoopback(true);
      const beacon: Beacon = { v: 1, id: this.identity, name: this.name, port };
      const data = Buffer.from(JSON.stringify(beacon));
      const announce = () => {
        socket.send(data, PORT, GROUP);
        this.expire();
      };
      announce();
      this.active = true;
      this.timer = setInterval(announce, 5000);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  /** Accepts only a schema-checked beacon and records its observed network address. */
  observe(bytes: Buffer, host: string): void {
    if (bytes.length > 1024) return;
    const now = Date.now();
    const allowance = this.inbound.get(host);
    if (!allowance || now - allowance.since > 1000) {
      if (this.inbound.size > 512) this.inbound.clear();
      this.inbound.set(host, { since: now, count: 1 });
    } else if (++allowance.count > 20) return;
    const beacon = decodeBeacon(bytes);
    if (
      !beacon ||
      beacon.id === this.identity ||
      (this.peers.size >= 256 && !this.peers.has(beacon.id))
    )
      return;
    const prior = this.peers.get(beacon.id);
    this.peers.set(beacon.id, {
      id: beacon.id,
      name: beacon.name,
      host,
      port: beacon.port,
      seen: Date.now(),
    });
    if (!prior || prior.name !== beacon.name || prior.host !== host || prior.port !== beacon.port)
      this.onChange(this.list());
  }

  /** Removes stale peers without treating their last status as live. */
  expire(now = Date.now()): void {
    let changed = false;
    for (const [id, peer] of this.peers) {
      if (now - peer.seen < 15_000) continue;
      this.peers.delete(id);
      changed = true;
    }
    if (changed) log.info('[fleet] discovery-expired reason=discovery peer=anonymous');
    if (changed) this.onChange(this.list());
  }

  /** Returns recently observed public peer endpoints. */
  list(): readonly Presence[] {
    return [...this.peers.values()];
  }

  /** Stops announcements and closes the multicast socket. */
  stop(): void {
    this.active = false;
    clearInterval(this.timer);
    this.timer = undefined;
    this.socket?.close();
    this.socket = null;
    this.peers.clear();
    this.inbound.clear();
    this.onChange([]);
  }
}
