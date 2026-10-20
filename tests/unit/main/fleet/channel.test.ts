import { afterEach, describe, expect, it, vi } from 'vitest';
import { Duplex } from 'node:stream';
import { FleetChannel } from '@main/fleet/channel';
import { MAX_FRAME, STATUS_PAGE_SIZE } from '@main/fleet/protocol';

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
    const waiting = channel.request('status', { projectOffset: 0, shellOffset: 0 });
    expect(sent).toHaveLength(1);
    socket.destroy();
    await expect(waiting).rejects.toThrow('Peer disconnected');
  });

  it('refuses an operation and expires a request without leaking its payload', async () => {
    vi.useFakeTimers();
    const { channel, socket, sent } = fixture();
    const denied = channel.request('status', { projectOffset: 0, shellOffset: 0 });
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
    const timedOut = channel.request('status', { projectOffset: 0, shellOffset: 0 });
    const assertion = expect(timedOut).rejects.toThrow('Fleet request timed out');
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
    socket.destroy();
  });

  it('keeps worst-case escaped status pages under the frame limit', () => {
    const { channel, socket, sent } = fixture();
    const message = {
      type: 'response' as const,
      id: 'a'.repeat(32),
      ok: true,
      value: {
        projects: Array.from({ length: STATUS_PAGE_SIZE }, (_, index) => ({
          id: index + 1,
          name: '\u0001'.repeat(160),
        })),
        shells: Array.from({ length: STATUS_PAGE_SIZE }, (_, index) => ({
          projectId: index + 1,
          shellIndex: index,
          agent: 'claude',
          state: 'blocked',
        })),
        projectOffset: 0,
        shellOffset: 0,
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

  it('closes the channel on a full outgoing buffer rather than silently dropping a page', () => {
    const socket = new Duplex({
      highWaterMark: 1,
      read() {},
      write() {},
    });
    const channel = new FleetChannel(socket);
    expect(() => channel.send({ type: 'response', id: 'a'.repeat(32), ok: false })).toThrow(
      'Fleet channel backpressure limit',
    );
    expect(socket.destroyed).toBe(true);
  });
  it('caps authenticated inbound frame rate even when pages arrive in one read', async () => {
    const { channel, socket } = fixture();
    const onMessage = vi.fn();
    channel.onMessage(onMessage);
    const frame = `${JSON.stringify({
      type: 'request',
      id: 'a'.repeat(32),
      op: 'status',
      args: { projectOffset: 0, shellOffset: 0 },
    })}\n`;
    socket.push(frame.repeat(129));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onMessage).toHaveBeenCalledTimes(128);
    expect(socket.destroyed).toBe(true);
  });
});
