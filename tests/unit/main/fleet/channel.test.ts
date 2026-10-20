import { afterEach, describe, expect, it, vi } from 'vitest';
import { Duplex } from 'node:stream';
import { FleetChannel } from '@main/fleet/channel';

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
    const waiting = channel.request('status', {});
    expect(sent).toHaveLength(1);
    socket.destroy();
    await expect(waiting).rejects.toThrow('Peer disconnected');
  });

  it('refuses an operation and expires a request without leaking its payload', async () => {
    vi.useFakeTimers();
    const { channel, socket, sent } = fixture();
    const denied = channel.request('status', {});
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
    const timedOut = channel.request('status', {});
    const assertion = expect(timedOut).rejects.toThrow('Fleet request timed out');
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
    socket.destroy();
  });
});
