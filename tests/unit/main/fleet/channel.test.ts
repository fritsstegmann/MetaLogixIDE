import { afterEach, describe, expect, it, vi } from 'vitest';
import { Duplex } from 'node:stream';
import { FleetChannel } from '@main/fleet/channel';
import { MAX_FRAME, ROOT_PAGE_SIZE, STATUS_PAGE_SIZE } from '@main/fleet/protocol';

function fixture() {
  const sent: string[] = [];
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      sent.push(chunk.toString('utf8'));
      callback();
    },
  });
  const channel = new FleetChannel(socket);
  return { socket, channel, sent };
}
afterEach(() => {
  vi.useRealTimers();
});

describe('fleet framed TLS channel', () => {
  it('rejects malformed frames and disconnects without dispatching commands', async () => {
    const { channel, socket } = fixture();
    const handler = vi.fn();
    channel.onMessage(handler);
    socket.push('{invalid\n');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(socket.destroyed).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects oversized frames before parsing or buffering further traffic', async () => {
    const { channel, socket } = fixture();

    const handler = vi.fn();
    channel.onMessage(handler);
    socket.push('x'.repeat(16_385));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(socket.destroyed).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
  it('never dispatches a network request with invalid shell IDs', async () => {
    const { channel, socket } = fixture();
    const handler = vi.fn();
    channel.onMessage(handler);
    socket.push(
      `${JSON.stringify({ type: 'request', id: 'a'.repeat(32), op: 'stop', args: { projectId: -1, shellIndex: 0 } })}\n`,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(socket.destroyed).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects unsolicited response IDs instead of accepting a replay', async () => {
    const { socket } = fixture();
    socket.push(
      `${JSON.stringify({ type: 'response', id: 'a'.repeat(32), ok: true, value: {} })}\n`,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(socket.destroyed).toBe(true);
  });

  it('rejects waiting requests when a peer disconnects', async () => {
    const { channel, socket, sent } = fixture();
    const waiting = channel.request('status', { rootOffset: 0, projectOffset: 0, shellOffset: 0 });
    expect(sent).toHaveLength(1);
    socket.destroy();
    await expect(waiting).rejects.toThrow('Peer disconnected');
  });
  it('labels an unclassified peer close unknown and an explicit stop local', async () => {
    const first = fixture();
    const unknown: string[] = [];
    first.channel.onClose((reason) => unknown.push(reason));
    first.socket.destroy();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unknown).toEqual(['unknown']);
    const second = fixture();
    const deliberate: string[] = [];
    second.channel.onClose((reason) => deliberate.push(reason));
    second.channel.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deliberate).toEqual(['local']);
  });


  it('keeps a pending request alive across a transient write stall and drain', async () => {
    let finishWrite: (() => void) | undefined;
    const sent: string[] = [];
    const socket = new Duplex({
      writableHighWaterMark: 1,
      read() {},
      write(chunk: Buffer, _encoding, done) {
        sent.push(chunk.toString());
        finishWrite = done;
      },
    });
    const channel = new FleetChannel(socket);
    const closed = vi.fn();
    channel.onClose(closed);
    const waiting = channel.request('status', { rootOffset: 0, projectOffset: 0, shellOffset: 0 });
    expect(socket.writableNeedDrain).toBe(true);
    expect(socket.destroyed).toBe(false);
    const outbound: unknown = JSON.parse(sent[0] ?? '{}');
    if (!outbound || typeof outbound !== 'object' || !('id' in outbound) ||
      typeof outbound.id !== 'string') throw new Error('Outbound request missing ID');
    const drained = vi.fn();
    socket.once('drain', drained);
    finishWrite?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toHaveBeenCalledOnce();
    socket.push(`${JSON.stringify({ type: 'response', id: outbound.id, ok: true, value: { ok: true } })}\n`);
    await expect(waiting).resolves.toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(closed).not.toHaveBeenCalled();
    channel.close();
  });

  it('fails closed on sustained buffered writes and settles pending requests', async () => {
    const socket = new Duplex({ read() {}, write() {} });
    const channel = new FleetChannel(socket);
    const reasons: string[] = [];
    channel.onClose((reason) => reasons.push(reason));
    const waiting = channel.request('status', { rootOffset: 0, projectOffset: 0, shellOffset: 0 });
    const frame = { type: 'terminal' as const, id: 'a'.repeat(32),
      projectId: 1, shellIndex: 0, kind: 'data' as const, data: 'x'.repeat(4096) };
    expect(() => {
      for (let index = 0; index < 30; index++) channel.send(frame);
    }).toThrow('Fleet channel backpressure limit');
    await expect(waiting).rejects.toThrow('Peer disconnected');
    expect(socket.destroyed).toBe(true);
    expect(reasons).toEqual(['pressure']);
  });

  it('reassembles partial and coalesced frames in order, then rejects extra fields', async () => {
    const { channel, socket } = fixture();
    const messages: string[] = [];
    channel.onMessage((message) => {
      if (message.type === 'request') messages.push(message.id);
    });
    const frame = (id: string) => JSON.stringify({ type: 'request', id, op: 'stop',
      args: { projectId: 1, shellIndex: 0 } });
    const first = frame('a'.repeat(32));
    socket.push(first.slice(0, 10));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(messages).toEqual([]);
    socket.push(`${first.slice(10)}\n${frame('b'.repeat(32))}\n`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(messages).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
    socket.push(`${JSON.stringify({ type: 'request', id: 'c'.repeat(32), op: 'stop',
      args: { projectId: 1, shellIndex: 0, secret: 'key sentinel' } })}\n`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(socket.destroyed).toBe(true);
    expect(messages).toHaveLength(2);
    channel.close();
  });

  it('refuses an operation and expires a request without leaking its payload', async () => {
    vi.useFakeTimers();
    const { channel, socket, sent } = fixture();
    const denied = channel.request('status', { rootOffset: 0, projectOffset: 0, shellOffset: 0 });
    const request = JSON.parse(sent[0] ?? '{}') as unknown;
    if (
      request === null ||
      typeof request !== 'object' ||
      !('id' in request) ||
      typeof request.id !== 'string'
    )
      throw new Error('Missing outbound request');
    socket.push(`${JSON.stringify({ type: 'response', id: request.id, ok: false })}\n`);
    await expect(denied).rejects.toThrow('Peer refused fleet operation');
    const timedOut = channel.request('status', { rootOffset: 0, projectOffset: 0, shellOffset: 0 });
    const assertion = expect(timedOut).rejects.toThrow('Fleet request timed out');
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
    socket.destroy();
  });

  it('reports a request deadline once without retaining a pending timer', async () => {
    vi.useFakeTimers();
    const { channel, socket } = fixture();
    const deadline = vi.fn();
    channel.onDeadline(deadline);
    const waiting = channel.request('status', { rootOffset: 0, projectOffset: 0, shellOffset: 0 });
    const assertion = expect(waiting).rejects.toThrow('Fleet request timed out');
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
    expect(deadline).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    channel.close();
    expect(socket.destroyed).toBe(true);
  });

  it('closes as transport failure if a socket write throws before queuing data', () => {
    const { channel, socket } = fixture();
    const reasons: string[] = [];
    channel.onClose((reason) => reasons.push(reason));
    vi.spyOn(socket, 'write').mockImplementation(() => {
      throw new Error('PRIVATE-SOCKET-ERROR-SENTINEL');
    });
    expect(() => channel.send({ type: 'response', id: 'a'.repeat(32), ok: false }))
      .toThrow('Peer disconnected');
    expect(reasons).toEqual(['transport']);
    expect(socket.destroyed).toBe(true);
  });

  it('keeps worst-case escaped status pages under the frame limit', () => {
    const { channel, socket, sent } = fixture();
    const message = {
      type: 'response' as const,
      id: 'a'.repeat(32),
      ok: true,
      value: {
        roots: Array.from({ length: ROOT_PAGE_SIZE }, (_, index) => ({
          id: index + 1,
          name: '\u0001'.repeat(160),
        })),
        projects: Array.from({ length: STATUS_PAGE_SIZE }, (_, index) => ({
          id: index + 1,
          rootId: index % ROOT_PAGE_SIZE + 1,
          name: '\u0001'.repeat(160),
        })),
        shells: Array.from({ length: STATUS_PAGE_SIZE }, (_, index) => ({
          projectId: index + 1,
          shellIndex: index,
          agent: 'claude',
          state: 'blocked',
        })),
        rootOffset: 0,
        projectOffset: 0,
        shellOffset: 0,
        rootTotal: 256,
        projectTotal: 256,
        shellTotal: 256,
        token: 'b'.repeat(32),
      },
    };
    channel.send(message);
    expect(Buffer.byteLength(sent[0] ?? '')).toBeLessThanOrEqual(MAX_FRAME);
    expect(socket.destroyed).toBe(false);
    channel.close();
  });

  it('does not treat a writable high-water mark as a failed write', () => {
    const socket = new Duplex({
      highWaterMark: 1,
      read() {},
      write(_chunk, _encoding, done) { done(); },
    });
    const channel = new FleetChannel(socket);
    channel.send({ type: 'response', id: 'a'.repeat(32), ok: false });
    expect(socket.destroyed).toBe(false);
    channel.close();
  });
  it('caps authenticated inbound frame rate even when pages arrive in one read', async () => {
    const { channel, socket } = fixture();
    const onMessage = vi.fn();
    channel.onMessage(onMessage);
    const frame = `${JSON.stringify({
      type: 'request',
      id: 'a'.repeat(32),
      op: 'status',
      args: { rootOffset: 0, projectOffset: 0, shellOffset: 0 },
    })}\n`;
    socket.push(frame.repeat(129));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onMessage).toHaveBeenCalledTimes(128);
    expect(socket.destroyed).toBe(true);
  });
  it('keeps an authenticated channel usable when the host clock moves backward', async () => {
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    const { channel, socket } = fixture();
    const onMessage = vi.fn();
    channel.onMessage(onMessage);
    const request = `${JSON.stringify({
      type: 'request',
      id: 'a'.repeat(32),
      op: 'status',
      args: { rootOffset: 0, projectOffset: 0, shellOffset: 0 },
    })}\n`;
    try {
      socket.push(request);
      await new Promise<void>((resolve) => setImmediate(resolve));
      clock.mockReturnValue(start + 11_000);
      socket.push(request);
      await new Promise<void>((resolve) => setImmediate(resolve));
      clock.mockReturnValue(start);
      socket.push(request);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(onMessage).toHaveBeenCalledTimes(3);
      expect(socket.destroyed).toBe(false);
    } finally {
      clock.mockRestore();
      channel.close();
    }
  });
});
