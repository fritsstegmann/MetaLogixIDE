import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetIdentityStore, type FleetKeychain } from '@main/fleet/identity';

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
    };
    await expect(new FleetIdentityStore(dir, broken).loadIdentity()).rejects.toThrow();
  });

  it('rejects owner-unsafe and symlink trust storage instead of following it', async () => {
    const { dir, keychain } = fixture();
    const outside = join(dir, 'outside');
    const store = new FleetIdentityStore(join(dir, 'fleet'), keychain);
    symlinkSync(outside, join(dir, 'fleet'));
    await expect(store.load()).rejects.toThrow();
  });
});
