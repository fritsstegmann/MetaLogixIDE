/** Credential-backed fleet identity and owner-only revocable peer trust. */
import 'reflect-metadata';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  X509Certificate,
} from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { X509CertificateGenerator } from '@peculiar/x509';

export interface FleetKeychain {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
}
export interface FleetIdentity {
  readonly id: string;
  readonly cert: string;
  readonly key: string;
}
export interface FleetTrust {
  readonly enabled: boolean;
  readonly trusted: readonly { readonly id: string; readonly name: string }[];
  readonly revoked: readonly string[];
}
const SERVICE = 'metaIDE.fleet.identity';
const FINGERPRINT = /^[0-9a-f]{64}$/;

async function systemKeychain(): Promise<FleetKeychain> {
  // Load the native module only after opt-in: missing keytar must not prevent the rest of the app from starting.
  // Its CJS functions may appear only on the default export in Electron.
  const module = await import('keytar');
  const candidate: unknown = module.default ?? module;
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    !('getPassword' in candidate) ||
    typeof candidate.getPassword !== 'function' ||
    !('setPassword' in candidate) ||
    typeof candidate.setPassword !== 'function'
  )
    throw new Error('Fleet credential store unavailable');
  return candidate as FleetKeychain;
}

function ensureSafe(path: string, directory: boolean): void {
  const info = lstatSync(path);
  if ((directory && !info.isDirectory()) || (!directory && !info.isFile()))
    throw new Error('Unsafe fleet storage path');
  if (
    process.platform !== 'win32' &&
    (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
  )
    throw new Error('Unsafe fleet storage permissions');
}

function parseTrust(value: unknown): FleetTrust {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid fleet trust store');
  const entry = value as Record<string, unknown>;
  if (
    Object.keys(entry).sort().join(',') !== 'enabled,revoked,trusted' ||
    typeof entry.enabled !== 'boolean' ||
    !Array.isArray(entry.trusted) ||
    !Array.isArray(entry.revoked) ||
    entry.trusted.length > 256 ||
    entry.revoked.length > 256
  )
    throw new Error('Invalid fleet trust store');
  const trusted: { id: string; name: string }[] = [];
  const revoked: string[] = [];
  for (const item of entry.trusted) {
    if (item === null || typeof item !== 'object' || Array.isArray(item))
      throw new Error('Invalid fleet trust store');
    const peer = item as Record<string, unknown>;
    if (
      Object.keys(peer).sort().join(',') !== 'id,name' ||
      typeof peer.id !== 'string' ||
      !FINGERPRINT.test(peer.id) ||
      typeof peer.name !== 'string' ||
      peer.name.length < 1 ||
      peer.name.length > 80
    )
      throw new Error('Invalid fleet trust store');
    trusted.push({ id: peer.id, name: peer.name });
  }
  for (const item of entry.revoked) {
    if (typeof item !== 'string' || !FINGERPRINT.test(item))
      throw new Error('Invalid fleet trust store');
    revoked.push(item);
  }
  if (
    new Set(trusted.map((peer) => peer.id)).size !== trusted.length ||
    new Set(revoked).size !== revoked.length ||
    trusted.some((peer) => revoked.includes(peer.id))
  )
    throw new Error('Conflicting fleet trust store');
  return { enabled: entry.enabled, trusted, revoked };
}

/** Loads a stable self-signed TLS identity and owner-only peer trust; storage errors prevent fleet startup. */
export class FleetIdentityStore {
  constructor(
    private readonly directory: string,
    private readonly keychain?: FleetKeychain,
  ) {}

  private ensureDirectory(): void {
    if (!existsSync(this.directory)) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    ensureSafe(this.directory, true);
  }

  /** Loads or generates the private identity only through the OS credential store. */
  async loadIdentity(requireExisting = false): Promise<FleetIdentity> {
    this.ensureDirectory();
    const vault = this.keychain ?? (await systemKeychain());
    const account = `tls-v1:${createHash('sha256').update(resolve(this.directory)).digest('hex')}`;
    const saved = await vault.getPassword(SERVICE, account);
    if (saved !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(saved) as unknown;
      } catch {
        throw new Error('Invalid fleet credential');
      }
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        !('key' in parsed) ||
        !('cert' in parsed) ||
        typeof parsed.key !== 'string' ||
        typeof parsed.cert !== 'string'
      )
        throw new Error('Invalid fleet credential');
      const cert = new X509Certificate(parsed.cert);
      const key = createPrivateKey(parsed.key);
      const derived = createPublicKey(key).export({ type: 'spki', format: 'der' });
      const actual = cert.publicKey.export({ type: 'spki', format: 'der' });
      if (
        !cert.verify(cert.publicKey) ||
        !derived.equals(actual) ||
        Number.isNaN(Date.parse(cert.validFrom)) ||
        Number.isNaN(Date.parse(cert.validTo)) ||
        Date.parse(cert.validFrom) > Date.now() ||
        Date.parse(cert.validTo) < Date.now()
      )
        throw new Error('Invalid fleet credential');
      return {
        cert: parsed.cert,
        key: parsed.key,
        id: createHash('sha256').update(cert.raw).digest('hex'),
      };
    }
    if (requireExisting)
      throw new Error('Fleet identity unavailable; existing trust cannot be restored');
    const keys = await globalThis.crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    if (!('privateKey' in keys) || !('publicKey' in keys))
      throw new Error('Fleet key generation failed');
    const cert = (
      await X509CertificateGenerator.createSelfSigned(
        {
          name: 'CN=MetaLogix IDE Fleet',
          keys,
          serialNumber: randomBytes(16).toString('hex'),
          notAfter: new Date(Date.now() + 10 * 365 * 86400_000),
          signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
        },
        globalThis.crypto,
      )
    ).toString('pem');
    const key = createPrivateKey({
      key: Buffer.from(await globalThis.crypto.subtle.exportKey('pkcs8', keys.privateKey)),
      format: 'der',
      type: 'pkcs8',
    })
      .export({ format: 'pem', type: 'pkcs8' })
      .toString();
    await vault.setPassword(SERVICE, account, JSON.stringify({ cert, key }));
    return {
      cert,
      key,
      id: createHash('sha256').update(new X509Certificate(cert).raw).digest('hex'),
    };
  }

  /** Reads peer trust without following symlinks or accepting permissive storage modes. */
  async load(): Promise<FleetTrust> {
    this.ensureDirectory();
    const path = join(this.directory, 'trust.json');
    let handle: number;
    try {
      handle = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return { enabled: false, trusted: [], revoked: [] };
      throw error;
    }
    try {
      const info = fstatSync(handle);
      if (
        !info.isFile() ||
        info.size > 65536 ||
        (process.platform !== 'win32' &&
          (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
      )
        throw new Error('Unsafe fleet trust store');
      return parseTrust(JSON.parse(readFileSync(handle, { encoding: 'utf8' })) as unknown);
    } finally {
      closeSync(handle);
    }
  }

  /** Atomically persists enabled state and revocable certificate fingerprints with owner-only permissions. */
  async save(trust: FleetTrust): Promise<void> {
    this.ensureDirectory();
    const valid = parseTrust(trust);
    const path = join(this.directory, 'trust.json');
    if (existsSync(path)) ensureSafe(path, false);
    const temp = join(this.directory, `.${randomBytes(16).toString('hex')}.tmp`);
    const handle = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(handle, JSON.stringify(valid), 'utf8');
      if (process.platform !== 'win32') chmodSync(temp, 0o600);
      closeSync(handle);
      renameSync(temp, path);
    } catch (error) {
      try {
        closeSync(handle);
      } catch {
        /* close may already have succeeded */
      }
      rmSync(temp, { force: true });
      throw error;
    }
  }
}
