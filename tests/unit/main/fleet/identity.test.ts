import { afterEach, describe, expect, it } from 'vitest';
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
import { FleetCredentialError, FleetIdentityStore, type FleetKeychain } from '@main/fleet/identity';

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
    expect([...values.values()].join(' ')).toContain('PRIVATE KEY');
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
});
