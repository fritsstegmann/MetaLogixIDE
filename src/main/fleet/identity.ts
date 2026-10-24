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
import log from 'electron-log/main';
import { decodeStoredSecret, encodeStoredSecret } from '../credential-encoding';

export interface FleetKeychain {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}
/** The stored identity exists but cannot be parsed or validated; only a reset recovers it. */
export class FleetCredentialError extends Error {
  constructor(options?: ErrorOptions) {
    super('Invalid fleet credential', options);
    this.name = 'FleetCredentialError';
  }
}
/** No stored identity exists although existing trust requires one; only a reset recovers it. */
export class FleetIdentityMissingError extends Error {
  constructor() {
    super('Fleet identity unavailable; existing trust cannot be restored');
    this.name = 'FleetIdentityMissingError';
  }
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
const MAX_TRUST_BYTES = 1024 * 1024;

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
    typeof candidate.setPassword !== 'function' ||
    !('deletePassword' in candidate) ||
    typeof candidate.deletePassword !== 'function'
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
    entry.revoked.length > Math.floor(MAX_TRUST_BYTES / 64)
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
  const revokedIds = new Set(revoked);
  if (
    new Set(trusted.map((peer) => peer.id)).size !== trusted.length ||
    revokedIds.size !== revoked.length ||
    trusted.some((peer) => revokedIds.has(peer.id))
  )
    throw new Error('Conflicting fleet trust store');
  return { enabled: entry.enabled, trusted, revoked };
}

/** Serialises a certificate and key for the credential store in the encoded, keyring-safe form. */
function serializeCredential(cert: string, key: string): string {
  return encodeStoredSecret(JSON.stringify({ cert, key }));
}

/**
 * Re-escapes raw control characters as JSON `\u` escapes. Plaintext gnome-keyring unescapes
 * `\n`, `\r` and `\t` in legacy JSON into raw characters that JSON forbids inside strings.
 * Its `\\` to `\` unescape is not undone: JSON.stringify of a PEM never emits a backslash
 * escape other than `\n`, and a lone backslash cannot be restored unambiguously.
 */
function escapeControlCharacters(text: string): string {
  return Array.from(text, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : char;
  }).join('');
}

/** Decodes a stored value to JSON; only legacy unprefixed values get the control-character repair. */
function parseStoredJson(saved: string): { value: unknown; legacy: boolean } {
  const { text, legacy } = decodeStoredSecret(saved);
  try {
    return { value: JSON.parse(text) as unknown, legacy };
  } catch (error) {
    if (!legacy) throw error;
    return { value: JSON.parse(escapeControlCharacters(text)) as unknown, legacy };
  }
}

/** Verifies the certificate self-signature, key match and validity window; throws on any failure. */
function validateIdentity(parsed: unknown): FleetIdentity {
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('key' in parsed) ||
    !('cert' in parsed) ||
    typeof parsed.key !== 'string' ||
    typeof parsed.cert !== 'string'
  )
    throw new Error('Malformed credential');
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
    throw new Error('Credential failed validation');
  return {
    cert: parsed.cert,
    key: parsed.key,
    id: createHash('sha256').update(cert.raw).digest('hex'),
  };
}

/** Generates a P-256 key pair and a ten-year self-signed certificate, both as PEM. */
async function generateCredential(): Promise<{ cert: string; key: string }> {
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
  return { cert, key };
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

  private account(): string {
    return `tls-v1:${createHash('sha256').update(resolve(this.directory)).digest('hex')}`;
  }

  /** Decodes, parses and verifies a stored credential; any malformed content raises FleetCredentialError. */
  private parseCredential(saved: string): { identity: FleetIdentity; legacy: boolean } {
    try {
      const { value, legacy } = parseStoredJson(saved);
      return { identity: validateIdentity(value), legacy };
    } catch (cause) {
      throw new FleetCredentialError({ cause });
    }
  }

  /** Rewrites a validated legacy entry encoded; a failed write keeps the old entry and is retried on the next load. */
  private async upgradeLegacy(
    vault: FleetKeychain,
    account: string,
    identity: FleetIdentity,
  ): Promise<void> {
    try {
      await vault.setPassword(SERVICE, account, serializeCredential(identity.cert, identity.key));
      log.info('[fleet] rewrote legacy identity in the encoded credential form');
    } catch (error) {
      log.warn(
        '[fleet] could not rewrite legacy identity; keeping it and retrying on next load:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** Removes this directory's identity from the credential store; other devices' entries are untouched. */
  async deleteIdentity(): Promise<void> {
    const vault = this.keychain ?? (await systemKeychain());
    await vault.deletePassword(SERVICE, this.account());
  }

  /** Loads or generates the private identity only through the OS credential store; unreadable content raises FleetCredentialError, a required but absent entry FleetIdentityMissingError. */
  async loadIdentity(requireExisting = false): Promise<FleetIdentity> {
    this.ensureDirectory();
    const vault = this.keychain ?? (await systemKeychain());
    const account = this.account();
    const saved = await vault.getPassword(SERVICE, account);
    if (saved !== null) {
      const { identity, legacy } = this.parseCredential(saved);
      if (legacy) await this.upgradeLegacy(vault, account, identity);
      return identity;
    }
    if (requireExisting) throw new FleetIdentityMissingError();
    const { cert, key } = await generateCredential();
    await vault.setPassword(SERVICE, account, serializeCredential(cert, key));
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
        info.size > MAX_TRUST_BYTES ||
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
    const serialized = JSON.stringify(valid);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_TRUST_BYTES)
      throw new Error('Fleet trust store exceeds size limit');
    const path = join(this.directory, 'trust.json');
    if (existsSync(path)) ensureSafe(path, false);
    const temp = join(this.directory, `.${randomBytes(16).toString('hex')}.tmp`);
    const handle = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(handle, serialized, 'utf8');
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

  /** Removes stale trusted peers if a failed write cannot persist a safe disabled trust file. */
  invalidate(): void {
    this.ensureDirectory();
    const path = join(this.directory, 'trust.json');
    if (!existsSync(path)) return;
    ensureSafe(path, false);
    rmSync(path);
  }
}
