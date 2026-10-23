import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  certificateIdentity,
  decodeBeacon,
  decodeMessage,
  pairingCode,
  validateSnapshot,
  validateStatus,
  validateProfiles,
  validateStatusPage,
  validateGitStatus,
  validArgs,
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
  it('rejects malformed profile operations and never accepts secret-bearing profile results', () => {
    const request = (op: string, args: unknown) =>
      decodeMessage(JSON.stringify({ type: 'request', id: 'c'.repeat(32), op, args }));
    for (const op of ['profiles', 'launch-cli', 'set-default-cli', 'remove-cli-profile'])
      expect(request(op, { projectId: 1, ...(op === 'remove-cli-profile' ? { name: 'Agent' } :
        op === 'set-default-cli' ? { name: null } :
        op === 'launch-cli' ? { profileName: 'Agent' } : {}) })).not.toBeNull();
    for (const [op, args] of [
      ['profiles', { projectId: 0 }],
      ['profiles', { projectId: 1, path: '/secret' }],
      ['launch-cli', { projectId: 1 }],
      ['launch-cli', { projectId: 1, argv: [] }],
      ['launch-cli', { projectId: 1, argv: ['x'.repeat(1025)] }],
      ['launch-cli', { projectId: 1, argv: ['x', ''] }],
      ['launch-cli', { projectId: 1, argv: ['x'], env: { SECRET: 'key' } }],
      ['launch-cli', { projectId: 1, argv: ['x'], save: true }],
      ['launch-cli', { projectId: 1, profileName: 'Agent', argv: ['x'], save: 'true' }],
      ['launch-cli', { projectId: 1, argv: Array.from({ length: 10 }, () => 'x'.repeat(1024)) }],
      ['profiles', { projectId: 1, env: { SECRET: 'private' } }],
      ['set-default-cli', { projectId: 1, name: 'Agent', argv: ['sh'] }],
      ['set-default-cli', { projectId: 1, name: ' '.repeat(81) }],
      ['set-default-cli', { projectId: 1, name: '' }],
      ['remove-cli-profile', { projectId: 1, name: null }],
    ] as const) expect(request(op, args)).toBeNull();
  });

  it('allows only bounded tab metadata, never shell command or path fields', () => {
    const shell = { projectId: 1, shellIndex: 0, agent: null, state: 'idle',
      launchName: 'Terminal', pinned: false, startedAt: null, lastActiveAt: '2026-10-21 12:00:00' };
    const status = { roots: [{ id: 4, name: 'Workspace' }],
      projects: [{ id: 1, rootId: 4, name: 'safe' }], shells: [shell] };
    expect(validateStatus(status)).toEqual(status);
    for (const bad of [
      { ...shell, launchName: '/secret/bin' }, { ...shell, launchName: 'x'.repeat(161) },
      { ...shell, pinned: 'false' }, { ...shell, startedAt: 'x'.repeat(100) },
      { ...shell, launchArgv: ['/secret/agent'] }, { ...shell, env: { TOKEN: 'secret' } },
    ]) expect(validateStatus({ ...status, shells: [bad] })).toBeNull();
  });
  it('rejects secret fields, duplicate identities and oversized profile metadata', () => {
    const valid = { profiles: [{ name: 'Agent', scope: 'project', icon: 'A' }],
      defaultCliName: 'Agent' };
    expect(validateProfiles(valid)).toEqual(valid);
    for (const profiles of [
      [{ ...valid.profiles[0], argv: ['/secret/bin'] }],
      [{ ...valid.profiles[0], env: { TOKEN: 'secret' } }],
      [{ ...valid.profiles[0], icon: '/secret' }],
      [{ ...valid.profiles[0], icon: 'x'.repeat(33) }],
      [{ ...valid.profiles[0], name: 'Agent\nspoof' }],
      [{ ...valid.profiles[0], icon: 'A\u001b[31m' }],
      [{ ...valid.profiles[0], scope: 'unknown' }],
      [valid.profiles[0], valid.profiles[0]],
      Array.from({ length: 65 }, (_, i) => ({ name: `Agent ${i}`, scope: 'global' })),
    ]) expect(validateProfiles({ ...valid, profiles })).toBeNull();
    expect(validateProfiles({ ...valid, defaultCliName: '/secret' })).toBeNull();
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
  it('checks metadata on each paginated shell before forwarding it', () => {
    const shell = { projectId: 1, shellIndex: 0, agent: null, state: 'idle',
      launchName: 'Terminal', pinned: true, startedAt: '2026-10-21 12:00:00',
      lastActiveAt: null };
    const page = { roots: [{ id: 2, name: 'Root' }],
      projects: [{ id: 1, rootId: 2, name: 'Project' }], shells: [shell],
      rootOffset: 0, projectOffset: 0, shellOffset: 0,
      rootTotal: 1, projectTotal: 1, shellTotal: 1, token: 'a'.repeat(32) };
    expect(validateStatusPage(page)?.shells).toEqual([shell]);
    expect(validateStatusPage({ ...page, shells: [{ ...shell, launchArgv: ['/secret/bin'] }] })).toBeNull();
    expect(validateStatusPage({ ...page, shells: [{ ...shell, pinned: 'true' }] })).toBeNull();
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
      shells: [{ projectId: 1, shellIndex: 0, agent: 'omp', state: 'busy',
        launchName: 'Agent', pinned: false, startedAt: null, lastActiveAt: null }],
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

describe('fleet git-status and notice frames', () => {
  const frameId = 'c'.repeat(32);
  const request = (args: unknown, extra: object = {}) =>
    JSON.stringify({ type: 'request', id: frameId, op: 'git-status', args, ...extra });
  const notice = { type: 'notice', id: frameId, projectId: 7, shellIndex: 2, kind: 'needs-input', body: 'Claude needs your input' };
  const repo = { isRepo: true, branch: 'main', dirty: true, ahead: 1, behind: 2, changedCount: 3 };

  it('accepts a git-status request carrying only a positive project ID', () => {
    expect(decodeMessage(request({ projectId: 7 }))).toEqual({ type: 'request', id: frameId, op: 'git-status', args: { projectId: 7 } });
    for (const args of [{}, { projectId: 0 }, { projectId: -1 }, { projectId: 1.5 }, { projectId: '7' },
      { projectId: 1_000_001 }, { projectId: 7, path: '/etc' }, { projectId: 7, shellIndex: 0 }, null, []])
      expect(decodeMessage(request(args))).toBeNull();
    expect(decodeMessage(request({ projectId: 7 }, { secret: 'x' }))).toBeNull();
    expect(validArgs('git-status', { projectId: 7 })).toBe(true);
    expect(validArgs('git-status', { projectId: 7, extra: 1 })).toBe(false);
  });

  it('accepts an exact, bounded git summary and nothing that could carry paths', () => {
    expect(validateGitStatus(repo)).toEqual(repo);
    expect(validateGitStatus({ ...repo, branch: null })).toEqual({ ...repo, branch: null });
    expect(validateGitStatus({ ...repo, branch: 'é'.repeat(127) })).not.toBeNull();
    const notRepo = { isRepo: false, branch: null, dirty: false, ahead: 0, behind: 0, changedCount: 0 };
    expect(validateGitStatus(notRepo)).toEqual(notRepo);
    for (const invalid of [
      { ...repo, files: { 'secret.txt': 'M' } },
      { ...repo, paths: ['/private'] },
      Object.fromEntries(Object.entries(repo).filter(([key]) => key !== 'changedCount')),
      { ...repo, branch: 'b'.repeat(256) },
      { ...repo, branch: 'é'.repeat(128) },
      { ...repo, branch: '' },
      { ...repo, branch: 'main\x1b[31m' },
      { ...repo, branch: 'main\0' },
      { ...repo, branch: 7 },
      { ...repo, ahead: -1 },
      { ...repo, behind: 1.5 },
      { ...repo, changedCount: 1_000_001 },
      { ...repo, changedCount: Number.NaN },
      { ...repo, dirty: 'yes' },
      { ...repo, isRepo: 1 },
      { ...notRepo, branch: 'main' },
      { ...notRepo, dirty: true },
      { ...notRepo, ahead: 1 },
      { ...notRepo, behind: 1 },
      { ...notRepo, changedCount: 1 },
      null,
      [],
      'main',
    ]) expect(validateGitStatus(invalid)).toBeNull();
  });

  it('accepts an exact notice frame with an allow-listed kind and a clean body of at most 200 characters', () => {
    expect(decodeMessage(JSON.stringify(notice))).toEqual(notice);
    expect(decodeMessage(JSON.stringify({ ...notice, kind: 'finished' }))).toEqual({ ...notice, kind: 'finished' });
    expect(decodeMessage(JSON.stringify({ ...notice, body: '😀'.repeat(200) }))).toEqual({ ...notice, body: '😀'.repeat(200) });
    expect(decodeMessage(JSON.stringify({ ...notice, body: 'x'.repeat(200) }))).not.toBeNull();
  });

  it('rejects oversize, extra-key, wrong-kind and control-character notices', () => {
    const missingBody = Object.fromEntries(Object.entries(notice).filter(([key]) => key !== 'body'));
    for (const invalid of [
      { ...notice, body: 'x'.repeat(201) },
      { ...notice, body: '😀'.repeat(201) },
      { ...notice, body: '' },
      { ...notice, body: 'Claude\x07needs input' },
      { ...notice, body: 'line\nbreak' },
      { ...notice, body: 'csi\u009b' },
      { ...notice, body: 42 },
      { ...notice, kind: 'command-finished' },
      { ...notice, kind: 'NEEDS-INPUT' },
      { ...notice, kind: null },
      { ...notice, projectId: 0 },
      { ...notice, projectId: '7' },
      { ...notice, shellIndex: -1 },
      { ...notice, shellIndex: 0.5 },
      { ...notice, id: 'short' },
      { ...notice, title: 'spoofed title' },
      { ...notice, peerId: 'a'.repeat(64) },
      missingBody,
    ]) expect(decodeMessage(JSON.stringify(invalid))).toBeNull();
    expect(decodeMessage(JSON.stringify({ ...notice, body: 'x'.repeat(16_400) }))).toBeNull();
  });
});
