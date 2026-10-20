import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  certificateIdentity,
  decodeBeacon,
  decodeMessage,
  pairingCode,
  validateSnapshot,
  validateStatus,
  validateStatusPage,
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

  it('accepts only bounded terminal frames, exact subscription IDs, and safe launch errors', () => {
    const request = (op: string, args: unknown) =>
      decodeMessage(JSON.stringify({ type: 'request', id: 'c'.repeat(32), op, args }));
    const terminal = (fields: Record<string, unknown>) =>
      decodeMessage(JSON.stringify({ type: 'terminal', id: 'c'.repeat(32),
        projectId: 1, shellIndex: 0, kind: 'data', data: '\x1b[31m🙂', ...fields }));
    expect(request('launch-claude', { projectId: 1 })).toMatchObject({ op: 'launch-claude' });
    expect(request('launch-claude', { projectId: 1, argv: ['sh'] })).toBeNull();
    expect(request('subscribe', { projectId: 1, shellIndex: 0, subscriptionId: 'a'.repeat(32) })).toMatchObject({ op: 'subscribe' });
    expect(request('subscribe', { projectId: 1, shellIndex: 0, subscriptionId: '../secret' })).toBeNull();
    expect(request('resize', { projectId: 1, shellIndex: 0, cols: 500, rows: 200 })).toMatchObject({ op: 'resize' });
    expect(request('resize', { projectId: 1, shellIndex: 0, cols: 501, rows: 200 })).toBeNull();
    expect(terminal({})).toMatchObject({ data: '\x1b[31m🙂' });
    expect(terminal({ data: 'x'.repeat(4097) })).toBeNull();
    expect(terminal({ kind: 'ready', data: 'private' })).toBeNull();
    expect(decodeMessage(JSON.stringify({ type: 'response', id: 'c'.repeat(32),
      ok: false, error: '/secret/path' }))).toBeNull();
  });

  it('rejects malformed status page offsets, tokens and impossible page lengths', () => {
    const request = (args: unknown) =>
      decodeMessage(JSON.stringify({ type: 'request', id: 'c'.repeat(32), op: 'status', args }));
    expect(request({ rootOffset: 0, projectOffset: 0, shellOffset: 0 })).not.toBeNull();
    for (const args of [
      {},
      { rootOffset: -1, projectOffset: 0, shellOffset: 0 },
      { rootOffset: 257, projectOffset: 0, shellOffset: 0 },
      { rootOffset: 0, projectOffset: -1, shellOffset: 0 },
      { rootOffset: 0, projectOffset: 257, shellOffset: 0 },
      { rootOffset: 0, projectOffset: 1.5, shellOffset: 0 },
      { rootOffset: 0, projectOffset: 0, shellOffset: 0, token: 'bad' },
      { rootOffset: 0, projectOffset: 1, shellOffset: 0 },
      { rootOffset: 1, projectOffset: 0, shellOffset: 0 },
      { rootOffset: 0, projectOffset: 0, shellOffset: 0, token: 'a'.repeat(32) },
      { rootOffset: 0, projectOffset: 0, shellOffset: 0, extra: true },
    ]) {
      expect(request(args)).toBeNull();
    }
  });

  it('requires exact page shape, totals, and bounded progress', () => {
    const page = {
      roots: [{ id: 4, name: 'Workspace' }],
      projects: [{ id: 1, rootId: 4, name: 'safe' }],
      shells: [],
      rootOffset: 0,
      projectOffset: 0,
      shellOffset: 0,
      rootTotal: 1,
      projectTotal: 1,
      shellTotal: 0,
      token: 'a'.repeat(32),
    };
    expect(validateStatusPage(page)).toEqual(page);
    for (const invalid of [
      { ...page, projectOffset: -1 },
      { ...page, rootOffset: 1 },
      { ...page, rootTotal: 257 },
      { ...page, rootTotal: 2 },
      { ...page, roots: [{ id: 4, name: 'x'.repeat(161) }] },
      { ...page, rootTotal: 2, roots: [...page.roots, ...page.roots] },
      { ...page, roots: [{ id: 4, name: '/private/workspace' }] },
      { ...page, roots: [{ id: 4, name: 'Workspace', path: '/secret' }] },
      { ...page, projects: [{ id: 1, rootId: 0, name: 'safe' }] },
      { ...page, projectOffset: 1 },
      { ...page, projectTotal: 257 },
      { ...page, projectTotal: 2 },
      { ...page, shellTotal: 1 },
      { ...page, token: 'x' },
      { ...page, privatePath: '/secret' },
      { ...page, projects: [{ id: 1, rootId: 4, name: 'x'.repeat(161) }] },
      {
        ...page,
        projectTotal: 13,
        projects: Array.from({ length: 13 }, (_, i) => ({ id: i + 1, rootId: 4, name: 'ok' })),
      },
    ])
      expect(validateStatusPage(invalid)).toBeNull();
  });

  it('rejects paths, invalid hierarchy, duplicate identities and malformed agent state', () => {
    const valid = {
      roots: [{ id: 4, name: 'Workspace' }],
      projects: [{ id: 1, rootId: 4, name: 'safe' }],
      shells: [{ projectId: 1, shellIndex: 0, agent: 'omp', state: 'busy' }],
    };
    expect(validateStatus(valid)).toEqual(valid);
    for (const invalid of [
      { ...valid, roots: [{ id: 4, name: 'Workspace', path: '/secret' }] },
      { ...valid, roots: [{ id: 4, name: '/private/workspace' }] },
      { ...valid, projects: [{ id: 1, rootId: 4, name: 'C:\\private\\secret' }] },
      { ...valid, roots: [{ id: 4, name: 'Workspace' }, { id: 4, name: 'Duplicate' }] },
      { ...valid, roots: [{ id: 0, name: 'Workspace' }] },
      { ...valid, roots: [{ id: 4, name: '\0' }] },
      { ...valid, roots: Array.from({ length: 257 }, (_, i) => ({ id: i + 1, name: 'Root' })) },
      { ...valid, projects: [{ id: 1, rootId: 99, name: 'orphan' }] },
      { ...valid, projects: [{ id: 1, rootId: 4, name: 'safe', path: '/secret' }] },
      { ...valid, projects: [{ id: 1, rootId: 4, name: 'safe' }, { id: 1, rootId: 4, name: 'duplicate' }] },
      { ...valid, shells: [{ projectId: 99, shellIndex: 0, agent: null, state: 'idle' }] },
      { ...valid, shells: [{ projectId: 1, shellIndex: 0, agent: null, state: 'unknown' }] },
      { ...valid, shells: [...valid.shells, ...valid.shells] },
    ]) expect(validateStatus(invalid)).toBeNull();
    expect(validateSnapshot({ output: 'x'.repeat(8193), alive: true })).toBeNull();
    expect(validateSnapshot({ output: 'ok', alive: true, token: 'secret' })).toBeNull();
  });
});
