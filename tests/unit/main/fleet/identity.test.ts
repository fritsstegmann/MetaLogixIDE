import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FleetCredentialError,
  FleetIdentityMissingError,
  FleetIdentityStore,
  type FleetKeychain,
} from '@main/fleet/identity';
import { decodeStoredSecret, encodeStoredSecret } from '@main/credential-encoding';
import log from 'electron-log/main';

const roots: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-trust-'));
  roots.push(dir);
  const values = new Map<string, string>();
  const keychain: FleetKeychain = {
    getPassword: async (_service, account) => values.get(account) ?? null,
    setPassword: async (_service, account, secret) => {
      values.set(account, secret);
    },
    deletePassword: async (_service, account) => values.delete(account),
  };
  return { dir, keychain, values };
}
/** Mimics plaintext gnome-keyring: written raw, read back through g_key_file_get_string's unescape. */
function gnomeRoundTrip(value: string): string {
  return value.replace(/\\([nrts\\])/g, (_match, code: string) =>
    code === 'n' ? '\n' : code === 'r' ? '\r' : code === 't' ? '\t' : code === 's' ? ' ' : '\\',
  );
}
const ENCODED = /^b64v1:[A-Za-z0-9+/=]+$/;
afterEach(() => {
  for (const path of roots.splice(0)) {
    chmodSync(path, 0o700);
    rmSync(path, { recursive: true, force: true });
  }
});

describe('fleet trust persistence', () => {
  it('stores private key exclusively in the credential store and pins approved identities', async () => {
    const { dir, keychain, values } = fixture();
    const first = new FleetIdentityStore(dir, keychain);
    const identity = await first.loadIdentity();
    await first.save({ enabled: true, trusted: [{ id: 'a'.repeat(64), name: 'A' }], revoked: [] });
    const next = new FleetIdentityStore(dir, keychain);
    expect((await next.loadIdentity()).id).toBe(identity.id);
    expect((await next.load()).trusted).toEqual([{ id: 'a'.repeat(64), name: 'A' }]);
    expect(readFileSync(join(dir, 'trust.json'), 'utf8')).not.toContain('PRIVATE KEY');
    expect([...values.values()].map((value) => decodeStoredSecret(value).text).join(' ')).toContain(
      'PRIVATE KEY',
    );
    if (process.platform !== 'win32') {
      expect(lstatSync(dir).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(dir, 'trust.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps more than 256 revoked identities within a bounded owner-only file', async () => {
    const { dir, keychain } = fixture();
    const store = new FleetIdentityStore(dir, keychain);
    const revoked = Array.from({ length: 257 }, (_, index) => index.toString(16).padStart(64, '0'));
    await store.save({ enabled: false, trusted: [], revoked });
    expect((await store.load()).revoked).toEqual(revoked);
    if (process.platform !== 'win32')
      expect(lstatSync(join(dir, 'trust.json')).mode & 0o777).toBe(0o600);
    await expect(
      store.save({
        enabled: true,
        trusted: [],
        revoked: Array.from({ length: 16_000 }, (_, index) => index.toString(16).padStart(64, '0')),
      }),
    ).rejects.toThrow('Fleet trust store exceeds size limit');
    expect((await store.load()).revoked).toEqual(revoked);
    writeFileSync(join(dir, 'trust.json'), 'x'.repeat(1024 * 1024 + 1));
    await expect(store.load()).rejects.toThrow('Unsafe fleet trust store');
  });

  it('creates distinct certificates for two runtimes with separate trust directories', async () => {
    const { dir, keychain } = fixture();
    const other = mkdtempSync(join(tmpdir(), 'fleet-trust-'));
    roots.push(other);
    const first = await new FleetIdentityStore(dir, keychain).loadIdentity();
    const second = await new FleetIdentityStore(other, keychain).loadIdentity();
    expect(second.id).not.toBe(first.id);
    expect(second.cert).not.toBe(first.cert);
  });

  it('fails closed when credential store cannot read or write', async () => {
    const { dir } = fixture();
    const broken: FleetKeychain = {
      getPassword: async () => {
        throw new Error('unavailable');
      },
      setPassword: async () => {
        throw new Error('unavailable');
      },
      deletePassword: async () => {
        throw new Error('unavailable');
      },
    };
    await expect(new FleetIdentityStore(dir, broken).loadIdentity()).rejects.toThrow();
  });

  it('throws a typed credential error for every unreadable stored identity', async () => {
    const { dir, keychain, values } = fixture();
    const store = new FleetIdentityStore(dir, keychain);
    const good = await store.loadIdentity();
    const [account] = [...values.keys()];
    if (!account) throw new Error('Missing fixture credential');
    const other = fixture();
    const foreign = await new FleetIdentityStore(other.dir, other.keychain).loadIdentity();
    const bad = [
      'not json',
      'null',
      '[]',
      '{}',
      JSON.stringify({ cert: 1, key: 2 }),
      JSON.stringify({ cert: 'garbage', key: good.key }),
      JSON.stringify({ cert: good.cert, key: 'garbage' }),
      JSON.stringify({ cert: good.cert, key: foreign.key }),
    ];
    for (const value of bad) {
      values.set(account, value);
      const error = await store.loadIdentity().catch((caught: unknown) => caught);
      expect(error, value).toBeInstanceOf(FleetCredentialError);
    }
  });

  it('does not classify a missing identity or a keychain outage as a credential error', async () => {
    const { dir, keychain } = fixture();
    const missing = await new FleetIdentityStore(dir, keychain)
      .loadIdentity(true)
      .catch((caught: unknown) => caught);
    expect(missing).toBeInstanceOf(Error);
    expect(missing).not.toBeInstanceOf(FleetCredentialError);
    const down = new FleetIdentityStore(dir, {
      ...keychain,
      getPassword: async () => {
        throw new Error('unavailable');
      },
    });
    const outage = await down.loadIdentity().catch((caught: unknown) => caught);
    expect(outage).not.toBeInstanceOf(FleetCredentialError);
  });

  it('deletes only this directory identity so a fresh one can be generated', async () => {
    const a = fixture();
    const b = fixture();
    const storeA = new FleetIdentityStore(a.dir, a.keychain);
    const first = await storeA.loadIdentity();
    await new FleetIdentityStore(b.dir, a.keychain).loadIdentity();
    expect(a.values.size).toBe(2);
    await storeA.deleteIdentity();
    expect(a.values.size).toBe(1);
    await expect(storeA.loadIdentity(true)).rejects.toThrow('Fleet identity unavailable');
    expect((await storeA.loadIdentity()).id).not.toBe(first.id);
  });

  it('rejects owner-unsafe and symlink trust storage instead of following it', async () => {
    const { dir, keychain } = fixture();
    const outside = join(dir, 'outside');
    const store = new FleetIdentityStore(join(dir, 'fleet'), keychain);
    symlinkSync(outside, join(dir, 'fleet'));
    await expect(store.load()).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a planted trust-file symlink or newly permissive trust file',
    async () => {
      const { dir, keychain } = fixture();
      const store = new FleetIdentityStore(dir, keychain);
      const trust = { enabled: true, trusted: [{ id: 'a'.repeat(64), name: 'A' }], revoked: [] };
      await store.save(trust);
      chmodSync(join(dir, 'trust.json'), 0o644);
      await expect(store.load()).rejects.toThrow('Unsafe fleet trust store');
      await expect(store.save(trust)).rejects.toThrow('Unsafe fleet storage permissions');
      rmSync(join(dir, 'trust.json'));
      const outside = join(dir, 'outside');
      writeFileSync(outside, JSON.stringify(trust), { mode: 0o600 });
      symlinkSync(outside, join(dir, 'trust.json'));
      await expect(store.load()).rejects.toThrow();
      await expect(store.save(trust)).rejects.toThrow('Unsafe fleet storage path');
    },
  );

  it('refuses lost or malformed identity instead of replacing a previously trusted certificate', async () => {
    const { dir, keychain, values } = fixture();
    const store = new FleetIdentityStore(dir, keychain);
    await expect(store.loadIdentity(true)).rejects.toThrow('existing trust cannot be restored');
    await store.loadIdentity();
    const account = [...values.keys()][0];
    if (!account) throw new Error('Missing credential account');
    values.set(account, '{bad');
    await expect(store.loadIdentity(true)).rejects.toThrow('Invalid fleet credential');
    values.set(account, JSON.stringify({ cert: 'bad', key: 'bad' }));
    await expect(store.loadIdentity(true)).rejects.toThrow();
  });

  it('rejects conflicting or malformed persisted trust without granting any peer access', async () => {
    const { dir, keychain } = fixture();
    const store = new FleetIdentityStore(dir, keychain);
    await store.load();
    for (const trust of [
      { enabled: true, trusted: [{ id: 'a'.repeat(64), name: 'A' }], revoked: ['a'.repeat(64)] },
      { enabled: true, trusted: [{ id: 'a'.repeat(64), name: 'A' }], revoked: ['b'] },
      { enabled: true, trusted: [], revoked: [], token: 'secret' },
    ]) {
      await expect(store.save(trust)).rejects.toThrow();
      expect(await store.load()).toEqual({ enabled: false, trusted: [], revoked: [] });
    }
    writeFileSync(join(dir, 'trust.json'), '{bad', { mode: 0o600 });
    await expect(store.load()).rejects.toThrow();
  });

  it('stores a new identity as prefixed base64 with no backslash or control character', async () => {
    const { dir, keychain, values } = fixture();
    const identity = await new FleetIdentityStore(dir, keychain).loadIdentity();
    const [stored] = [...values.values()];
    expect(stored).toMatch(ENCODED);
    expect(stored).not.toMatch(/[\\\u0000-\u001f]/);
    expect(gnomeRoundTrip(stored ?? '')).toBe(stored);
    expect(JSON.parse(decodeStoredSecret(stored ?? '').text)).toEqual({
      cert: identity.cert,
      key: identity.key,
    });
  });

  it('loads an encoded identity unchanged and does not rewrite it', async () => {
    const { dir, keychain, values } = fixture();
    const first = await new FleetIdentityStore(dir, keychain).loadIdentity();
    const writes: string[] = [];
    const watched: FleetKeychain = {
      ...keychain,
      setPassword: async (service, account, secret) => {
        writes.push(secret);
        await keychain.setPassword(service, account, secret);
      },
    };
    const again = await new FleetIdentityStore(dir, watched).loadIdentity(true);
    expect(again).toEqual(first);
    expect(writes).toEqual([]);
    expect([...values.values()][0]).toMatch(ENCODED);
  });

  it('loads a legacy identity mangled by the gnome-keyring round-trip and rewrites it encoded', async () => {
    const { dir, keychain, values } = fixture();
    const store = new FleetIdentityStore(dir, keychain);
    const identity = await store.loadIdentity();
    const [account] = [...values.keys()];
    if (!account) throw new Error('Missing fixture credential');
    const legacy = JSON.stringify({ cert: identity.cert, key: identity.key });
    const mangled = gnomeRoundTrip(legacy);
    expect(mangled).toContain('\n');
    expect(() => JSON.parse(mangled)).toThrow();
    values.set(account, mangled);
    expect(await store.loadIdentity(true)).toEqual(identity);
    expect(values.get(account)).toMatch(ENCODED);
    expect(decodeStoredSecret(values.get(account) ?? '').text).toBe(legacy);
    expect(await new FleetIdentityStore(dir, keychain).loadIdentity(true)).toEqual(identity);
  });

  it('repairs carriage returns and tabs that the gnome-keyring round-trip unescaped', async () => {
    const { dir, keychain, values } = fixture();
    const store = new FleetIdentityStore(dir, keychain);
    const identity = await store.loadIdentity();
    const [account] = [...values.keys()];
    if (!account) throw new Error('Missing fixture credential');
    const crlf = {
      cert: identity.cert.replace(/\n/g, '\r\n'),
      key: identity.key.replace(/\n/g, '\r\n'),
    };
    values.set(account, gnomeRoundTrip(JSON.stringify({ ...crlf, note: 'a\tb' })));
    expect((await store.loadIdentity(true)).id).toBe(identity.id);
    expect(JSON.parse(decodeStoredSecret(values.get(account) ?? '').text)).toEqual(crlf);
  });

  it('rewrites an intact legacy JSON identity in the encoded form', async () => {
    const { dir, keychain, values } = fixture();
    const store = new FleetIdentityStore(dir, keychain);
    const identity = await store.loadIdentity();
    const [account] = [...values.keys()];
    if (!account) throw new Error('Missing fixture credential');
    const legacy = JSON.stringify({ cert: identity.cert, key: identity.key });
    values.set(account, legacy);
    expect(await store.loadIdentity(true)).toEqual(identity);
    expect(values.get(account)).toBe(encodeStoredSecret(legacy));
  });

  it('still returns a valid legacy identity when rewriting it fails, leaving the entry as it was', async () => {
    const { dir, keychain, values } = fixture();
    const identity = await new FleetIdentityStore(dir, keychain).loadIdentity();
    const [account] = [...values.keys()];
    if (!account) throw new Error('Missing fixture credential');
    const mangled = gnomeRoundTrip(JSON.stringify({ cert: identity.cert, key: identity.key }));
    values.set(account, mangled);
    const readOnly: FleetKeychain = {
      ...keychain,
      setPassword: async () => {
        throw new Error('PRIVATE-KEY-REWRITE-FAILURE-SENTINEL');
      },
    };
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    expect(await new FleetIdentityStore(dir, readOnly).loadIdentity(true)).toEqual(identity);
    expect(values.get(account)).toBe(mangled);
    expect(warn.mock.calls.flat().join(' ')).toContain('credential-rewrite-failed');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('PRIVATE-KEY-REWRITE-FAILURE-SENTINEL');
    warn.mockRestore();
  });

  it('rejects hostile encoded or mangled content with a credential error and never rewrites it', async () => {
    const { dir, keychain, values } = fixture();
    const store = new FleetIdentityStore(dir, keychain);
    const good = await store.loadIdentity();
    const [account] = [...values.keys()];
    if (!account) throw new Error('Missing fixture credential');
    const other = fixture();
    const foreign = await new FleetIdentityStore(other.dir, other.keychain).loadIdentity();
    const body = good.cert.split('\n')[1] ?? '';
    const flipped = body.slice(0, 20) + (body[20] === 'A' ? 'B' : 'A') + body.slice(21);
    const tampered = good.cert.replace(body, flipped);
    const hostile = [
      'b64v1:',
      'b64v1:!!!not-base64!!!',
      'b64v1:eyJjZXJ0Ijo',
      encodeStoredSecret('not json'),
      encodeStoredSecret('{"cert":"x","key":"y"}'),
      encodeStoredSecret(JSON.stringify({ cert: good.cert, key: foreign.key })),
      encodeStoredSecret(gnomeRoundTrip(JSON.stringify({ cert: good.cert, key: good.key }))),
      gnomeRoundTrip(JSON.stringify({ cert: tampered, key: good.key })),
      gnomeRoundTrip(JSON.stringify({ cert: foreign.cert, key: good.key })),
      gnomeRoundTrip(JSON.stringify({ cert: good.cert, key: foreign.key })),
      gnomeRoundTrip(JSON.stringify({ cert: good.cert, key: good.key })).replace('{', '{"x":1\n'),
      `${gnomeRoundTrip(JSON.stringify({ cert: good.cert, key: good.key }))}\ntrailing`,
    ];
    for (const value of hostile) {
      values.set(account, value);
      const error = await store.loadIdentity(true).catch((caught: unknown) => caught);
      expect(error, value.slice(0, 40)).toBeInstanceOf(FleetCredentialError);
      expect(values.get(account), value.slice(0, 40)).toBe(value);
    }
  });

  it('raises a typed missing-identity error when existing trust requires an identity that is gone', async () => {
    const { dir, keychain, values } = fixture();
    const missing = await new FleetIdentityStore(dir, keychain)
      .loadIdentity(true)
      .catch((caught: unknown) => caught);
    expect(missing).toBeInstanceOf(FleetIdentityMissingError);
    expect(missing).not.toBeInstanceOf(FleetCredentialError);
    expect(values.size).toBe(0);
  });
});
