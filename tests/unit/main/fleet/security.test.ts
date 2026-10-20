import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  certificateIdentity,
  decodeBeacon,
  decodeMessage,
  pairingCode,
  validateSnapshot,
  validateStatus,
} from '@main/fleet/protocol';

const id = 'a'.repeat(64);
const other = 'b'.repeat(64);

describe('fleet network boundaries', () => {
  it('accepts only minimal public discovery data and fixed protocol version', () => {
    expect(
      decodeBeacon(Buffer.from(JSON.stringify({ v: 1, id, name: 'Machine', port: 43121 }))),
    ).toEqual({ v: 1, id, name: 'Machine', port: 43121 });
    expect(
      decodeBeacon(
        Buffer.from(JSON.stringify({ v: 1, id, name: 'Machine', port: 43121, projects: [] })),
      ),
    ).toBeNull();
    expect(decodeBeacon(Buffer.alloc(1025))).toBeNull();
    expect(
      decodeBeacon(Buffer.from(JSON.stringify({ v: 2, id, name: 'Machine', port: 43121 }))),
    ).toBeNull();
    expect(
      decodeBeacon(Buffer.from(JSON.stringify({ v: 1, id, name: 'Machine', port: 65536 }))),
    ).toBeNull();
  });

  it('binds the comparison code to both certified identities and both fresh nonces', () => {
    const a = randomBytes(32).toString('hex');
    const b = randomBytes(32).toString('hex');
    const code = pairingCode(id, other, a, b);
    expect(code).toMatch(/^\d{4}-\d{4}-\d{4}$/);
    expect(pairingCode(other, id, b, a)).toBe(code);
    expect(pairingCode(id, other, a, randomBytes(32).toString('hex'))).not.toBe(code);
    expect(pairingCode(id, other, randomBytes(32).toString('hex'), b)).not.toBe(code);
    expect(pairingCode(id, 'c'.repeat(64), a, b)).not.toBe(code);
  });

  it('requires the certified identity, not an advertised ID or claimed handshake ID', () => {
    const cert = Buffer.from('actual peer certificate');
    const fingerprint = certificateIdentity(cert);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toBe(id);
  });

  it('rejects oversized, malformed and extra-property control frames', () => {
    expect(decodeMessage('{')).toBeNull();
    expect(decodeMessage(' '.repeat(16385))).toBeNull();
    expect(
      decodeMessage(
        JSON.stringify({
          type: 'request',
          id: 'c'.repeat(32),
          op: 'status',
          args: {},
          secret: 'x',
        }),
      ),
    ).toBeNull();
    expect(
      decodeMessage(
        JSON.stringify({
          type: 'request',
          id: 'c'.repeat(32),
          op: 'write',
          args: { projectId: -1, shellIndex: 0, data: 'x' },
        }),
      ),
    ).toBeNull();
    expect(
      decodeMessage(
        JSON.stringify({
          type: 'request',
          id: 'c'.repeat(32),
          op: 'write',
          args: { projectId: 1, shellIndex: 0, data: 'x'.repeat(8193) },
        }),
      ),
    ).toBeNull();
  });

  it('rejects paths, unexpected metadata, oversized output and malformed agent state', () => {
    expect(
      validateStatus({ projects: [{ id: 1, name: 'hello', path: '/secret' }], shells: [] }),
    ).toBeNull();
    expect(
      validateStatus({
        projects: [],
        shells: [{ projectId: 1, shellIndex: 0, agent: null, state: 'unknown' }],
      }),
    ).toBeNull();
    expect(
      validateStatus({
        projects: Array.from({ length: 257 }, (_, i) => ({ id: i, name: 'x' })),
        shells: [],
      }),
    ).toBeNull();
    expect(validateSnapshot({ output: 'x'.repeat(8193), alive: true })).toBeNull();
    expect(validateSnapshot({ output: 'ok', alive: true, token: 'secret' })).toBeNull();
    expect(
      validateStatus({
        projects: [{ id: 1, name: 'safe' }],
        shells: [{ projectId: 1, shellIndex: 0, agent: 'omp', state: 'busy' }],
      }),
    ).toEqual({
      projects: [{ id: 1, name: 'safe' }],
      shells: [{ projectId: 1, shellIndex: 0, agent: 'omp', state: 'busy' }],
    });
  });
});
