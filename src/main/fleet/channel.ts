/** TLS application framing caps memory, request time and concurrent commands. */
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { Duplex } from 'node:stream';
import { decodeMessage, MAX_FRAME, type Operation, type WireMessage } from './protocol';

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** Exchanges bounded JSON frames over one already authenticated TLS socket. */
export class FleetChannel {
  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');
  private readonly pending = new Map<string, Pending>();
  private readonly handlers = new Set<(message: WireMessage) => void>();
  private readonly closedHandlers = new Set<() => void>();
  private closed = false;
  private count = 0;
  private window = Date.now();
  constructor(readonly socket: Duplex) {
    socket.on('data', (bytes: Buffer) => {
      this.receive(bytes);
    });
    socket.on('close', () => {
      this.close();
    });
    socket.on('error', () => {
      this.close();
    });
  }

  /** Registers inbound commands; the caller must authorize every command. */
  onMessage(listener: (message: WireMessage) => void): void {
    this.handlers.add(listener);
  }

  /** Registers transport loss notification for offline status and pending pairing expiry. */
  onClose(listener: () => void): void {
    this.closedHandlers.add(listener);
  }

  /** Sends one bounded protocol frame or closes a channel that cannot drain. */
  send(message: WireMessage): void {
    if (this.closed) throw new Error('Peer disconnected');
    const data = `${JSON.stringify(message)}\n`;
    if (
      Buffer.byteLength(data) > MAX_FRAME ||
      this.socket.writableLength > 65_536 ||
      !this.socket.write(data)
    ) {
      this.close();
      throw new Error('Fleet channel backpressure limit');
    }
  }

  /** Sends one operation with a bounded response deadline and pending limit. */
  request(op: Operation, args: Record<string, unknown>): Promise<unknown> {
    if (this.pending.size >= 16) return Promise.reject(new Error('Too many fleet requests'));
    const id = randomBytes(16).toString('hex');
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Fleet request timed out'));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ type: 'request', id, op, args });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private receive(bytes: Buffer): void {
    if (this.closed || bytes.length + Buffer.byteLength(this.buffer) > MAX_FRAME * 2) {
      this.close();
      return;
    }
    this.buffer += this.decoder.write(bytes);
    while (true) {
      const end = this.buffer.indexOf('\n');
      if (end === -1) {
        if (Buffer.byteLength(this.buffer) > MAX_FRAME) this.close();
        return;
      }
      const frame = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      const message = decodeMessage(frame);
      if (!message || !this.allowFrame()) {
        this.close();
        return;
      }
      if (message.type === 'response') {
        const pending = this.pending.get(message.id);
        if (!pending) {
          this.close();
          return;
        }
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.value);
        else {
          const errors = {
            'permission-mode': 'Choose a Claude permission mode on the remote machine first',
            'claude-missing': 'Claude is unavailable on the remote machine',
            'shell-cap': 'Remote shell limit reached; unpin a shell or raise the cap',
            'project-unavailable': 'Remote project folder is unavailable',
          };
          pending.reject(new Error(message.error ? errors[message.error] : 'Peer refused fleet operation'));
        }
      } else for (const listener of this.handlers) listener(message);
    }
  }

  private allowFrame(): boolean {
    const now = Date.now();
    if (now - this.window > 1000) {
      this.window = now;
      this.count = 0;
    }
    this.count++;
    return this.count <= 128;
  }

  /** Disconnects immediately and rejects outstanding requests. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Peer disconnected'));
    }
    this.pending.clear();
    for (const listener of this.closedHandlers) listener();
  }
}
