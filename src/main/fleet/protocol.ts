/** Strict fleet wire validation keeps discovery public and control frames bounded. */
import { createHash } from 'node:crypto';
import type { FleetStatus } from '../../shared/fleet-contract';

export const MAX_FRAME = 16_384;
export const STATUS_PAGE_SIZE = 12;
export const ROOT_PAGE_SIZE = 2;
export interface Beacon {
  readonly v: 1;
  readonly id: string;
  readonly name: string;
  readonly port: number;
}
export type Operation = 'status' | 'launch' | 'launch-claude' | 'profiles' | 'launch-cli' | 'set-default-cli' | 'remove-cli-profile' | 'stop' | 'write' | 'snapshot' | 'subscribe' | 'unsubscribe' | 'resize';
export type WireMessage =
  | { readonly type: 'hello'; readonly id: string; readonly nonce: string }
  | { readonly type: 'approve'; readonly id: string; readonly nonce: string }
  | {
      readonly type: 'request';
      readonly id: string;
      readonly op: Operation;
      readonly args: Record<string, unknown>;
    }
  | {
      readonly type: 'response';
      readonly id: string;
      readonly ok: boolean;
      readonly value?: unknown;
      readonly error?: 'permission-mode' | 'claude-missing' | 'shell-cap' | 'project-unavailable';
    }
  | { readonly type: 'terminal'; readonly id: string; readonly projectId: number; readonly shellIndex: number; readonly kind: 'snapshot' | 'ready' | 'data' | 'exit'; readonly data: string };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));
const hex = (value: unknown, length: number): value is string =>
  typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value);
const index = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value, 'utf8') <= max &&
  !value.includes('\0');
const profileName = (value: unknown): value is string =>
  text(value, 80) && value.trim().length > 0 &&
  !/[\/\\\p{Cc}]/u.test(value);
const timestamp = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && value.length <= 40 &&
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])[ T](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value));

/** Restricts peer-facing profile lists to a bounded allow-list of display metadata. */
export function validateProfiles(value: unknown): {
  profiles: readonly { name: string; scope: 'project' | 'global'; icon?: string }[];
  defaultCliName: string | null;
} | null {
  if (!record(value) || !keys(value, ['profiles', 'defaultCliName']) ||
    Object.keys(value).length !== 2 || !Array.isArray(value.profiles) ||
    value.profiles.length > 64 ||
    (value.defaultCliName !== null && !profileName(value.defaultCliName))) return null;
  const names = new Set<string>();
  const profiles: { name: string; scope: 'project' | 'global'; icon?: string }[] = [];
  for (const item of value.profiles) {
    if (!record(item) || !keys(item, ['name', 'scope', 'icon']) ||
      !profileName(item.name) || names.has(item.name) ||
      (item.scope !== 'project' && item.scope !== 'global') ||
      (Object.hasOwn(item, 'icon') && (!text(item.icon, 32) || /[\/\\\p{Cc}]/u.test(item.icon)))) return null;
    names.add(item.name);
    profiles.push({ name: item.name, scope: item.scope,
      ...(typeof item.icon === 'string' ? { icon: item.icon } : {}) });
  }
  return { profiles, defaultCliName: value.defaultCliName };
}

/** Decodes a public multicast beacon without accepting private or extra fields. */
export function decodeBeacon(bytes: Buffer): Beacon | null {
  if (bytes.length > 1024) return null;
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return null;
  }
  if (
    !record(value) ||
    !keys(value, ['v', 'id', 'name', 'port']) ||
    Object.keys(value).length !== 4
  )
    return null;
  if (
    value.v !== 1 ||
    !hex(value.id, 64) ||
    !text(value.name, 80) ||
    !index(value.port) ||
    value.port < 1 ||
    value.port > 65535
  )
    return null;
  return { v: 1, id: value.id, name: value.name, port: value.port };
}

/** Derives a symmetric comparison code from both TLS certificate identities and both session nonces. */
export function pairingCode(
  first: string,
  second: string,
  firstNonce: string,
  secondNonce: string,
): string {
  const ordered =
    first < second
      ? [first, firstNonce, second, secondNonce]
      : [second, secondNonce, first, firstNonce];
  const digest = createHash('sha256')
    .update('metaide-fleet-pair-v1\0')
    .update(ordered.join('\0'))
    .digest();
  const digits = (digest.readUIntBE(0, 6) % 1_000_000_000_000).toString().padStart(12, '0');
  return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8)}`;
}

/** Identifies only the certificate actually delivered by the TLS handshake, never its beacon claim. */
export function certificateIdentity(certificate: Buffer): string {
  return createHash('sha256').update(certificate).digest('hex');
}

/** Validates bounded operation arguments before local IPC sends and after peer decoding. */
export function validArgs(op: Operation, args: unknown): args is Record<string, unknown> {
  if (!record(args)) return false;
  if (op === 'status') {
    if (
      !keys(args, ['rootOffset', 'projectOffset', 'shellOffset', 'token']) ||
      !index(args.rootOffset) ||
      args.rootOffset > 256 ||
      !index(args.projectOffset) ||
      args.projectOffset > 256 ||
      !index(args.shellOffset) ||
      args.shellOffset > 256
    )
      return false;
    const initial = args.rootOffset === 0 && args.projectOffset === 0 && args.shellOffset === 0;
    return initial
      ? Object.keys(args).length === 3
      : Object.keys(args).length === 4 && hex(args.token, 32);
  }
  if (op === 'unsubscribe')
    return keys(args, ['subscriptionId']) && Object.keys(args).length === 1 && hex(args.subscriptionId, 32);
  if (!index(args.projectId) || args.projectId < 1) return false;
  if (op === 'launch' || op === 'launch-claude')
    return keys(args, ['projectId']) && Object.keys(args).length === 1;
  if (op === 'profiles')
    return keys(args, ['projectId']) && Object.keys(args).length === 1;
  if (op === 'set-default-cli')
    return keys(args, ['projectId', 'name']) && Object.keys(args).length === 2 &&
      (args.name === null || profileName(args.name));
  if (op === 'remove-cli-profile')
    return keys(args, ['projectId', 'name']) && Object.keys(args).length === 2 && profileName(args.name);
  if (op === 'launch-cli') {
    if (!keys(args, ['projectId', 'profileName', 'argv', 'save']) ||
      (args.profileName !== undefined && !profileName(args.profileName)) ||
      (args.save !== undefined && typeof args.save !== 'boolean') ||
      (args.argv !== undefined && (!Array.isArray(args.argv) || args.argv.length < 1 ||
        args.argv.length > 24 || args.argv.some((part: unknown) => !text(part, 1024)))) ||
      Buffer.byteLength(JSON.stringify(args), 'utf8') > 8192) return false;
    return (args.profileName !== undefined || args.argv !== undefined) &&
      (args.save !== true || (args.profileName !== undefined && args.argv !== undefined));
  }
  if (!index(args.shellIndex)) return false;
  if (op === 'subscribe')
    return keys(args, ['projectId', 'shellIndex', 'subscriptionId']) &&
      Object.keys(args).length === 3 && hex(args.subscriptionId, 32);
  if (op === 'resize')
    return keys(args, ['projectId', 'shellIndex', 'cols', 'rows']) &&
      Object.keys(args).length === 4 && index(args.cols) && args.cols >= 2 &&
      args.cols <= 500 && index(args.rows) && args.rows >= 2 && args.rows <= 200;
  if (op === 'write')
    return keys(args, ['projectId', 'shellIndex', 'data']) &&
      Object.keys(args).length === 3 && text(args.data, 8192);
  return keys(args, ['projectId', 'shellIndex']) && Object.keys(args).length === 2;
}

/** Parses a network frame as an exact, limited command or pairing message. */
export function decodeMessage(frame: string): WireMessage | null {
  if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME) return null;
  let value: unknown;
  try {
    value = JSON.parse(frame) as unknown;
  } catch {
    return null;
  }
  if (!record(value) || !hex(value.id, 32)) return null;
  if (value.type === 'hello' || value.type === 'approve') {
    if (
      !keys(value, ['type', 'id', 'nonce']) ||
      Object.keys(value).length !== 3 ||
      !hex(value.nonce, 64)
    )
      return null;
    return { type: value.type, id: value.id, nonce: value.nonce };
  }
  if (value.type === 'terminal') {
    if (!keys(value, ['type', 'id', 'projectId', 'shellIndex', 'kind', 'data']) ||
      Object.keys(value).length !== 6 || !index(value.projectId) || value.projectId < 1 ||
      !index(value.shellIndex) || typeof value.data !== 'string' ||
      Buffer.byteLength(value.data, 'utf8') > 4096 ||
      (value.kind !== 'snapshot' && value.kind !== 'ready' && value.kind !== 'data' && value.kind !== 'exit') ||
      ((value.kind === 'ready' || value.kind === 'exit') && value.data !== ''))
      return null;
    return { type: 'terminal', id: value.id, projectId: value.projectId, shellIndex: value.shellIndex, kind: value.kind, data: value.data };
  }
  if (value.type === 'request') {
    if (!keys(value, ['type', 'id', 'op', 'args']) || Object.keys(value).length !== 4) return null;
    if (value.op !== 'status' && value.op !== 'launch' && value.op !== 'launch-claude' &&
      value.op !== 'profiles' && value.op !== 'launch-cli' &&
      value.op !== 'set-default-cli' && value.op !== 'remove-cli-profile' &&
      value.op !== 'stop' && value.op !== 'write' && value.op !== 'snapshot' &&
      value.op !== 'subscribe' && value.op !== 'unsubscribe' && value.op !== 'resize')
      return null;
    if (!validArgs(value.op, value.args)) return null;
    return { type: 'request', id: value.id, op: value.op, args: value.args };
  }
  if (value.type === 'response') {
    if (!keys(value, ['type', 'id', 'ok', 'value', 'error']) || typeof value.ok !== 'boolean') return null;
    if (value.ok && (Object.hasOwn(value, 'error') || !Object.hasOwn(value, 'value'))) return null;
    if (!value.ok && (Object.hasOwn(value, 'value') ||
      (value.error !== undefined && value.error !== 'permission-mode' && value.error !== 'claude-missing' &&
       value.error !== 'shell-cap' && value.error !== 'project-unavailable'))) return null;
    if (value.ok) return { type: 'response', id: value.id, ok: true, value: value.value };
    if (value.error === 'permission-mode' || value.error === 'claude-missing' ||
        value.error === 'shell-cap' || value.error === 'project-unavailable')
      return { type: 'response', id: value.id, ok: false, error: value.error };
    return { type: 'response', id: value.id, ok: false };
  }
  return null;
}

/** Accepts only bounded status fields and complete, unambiguous hierarchy. */
export function validateStatus(value: unknown): FleetStatus | null {
  const status = validateStatusRows(value);
  if (!status) return null;
  const roots = new Set(status.roots.map((root) => root.id));
  const projects = new Set(status.projects.map((project) => project.id));
  if (status.projects.some((project) => !roots.has(project.rootId)) ||
    status.shells.some((shell) => !projects.has(shell.projectId))) return null;
  return status;
}

function validIdentity(item: unknown, fields: readonly string[]): item is Record<string, unknown> & { id: number; name: string } {
  return record(item) && keys(item, fields) && Object.keys(item).length === fields.length &&
    index(item.id) && item.id > 0 && text(item.name, 160) &&
    !item.name.includes('/') && !item.name.includes('\\');
}

function validateStatusRows(value: unknown): FleetStatus | null {
  if (!record(value) || !keys(value, ['roots', 'projects', 'shells']) ||
    Object.keys(value).length !== 3 || !Array.isArray(value.roots) ||
    !Array.isArray(value.projects) || !Array.isArray(value.shells) ||
    value.roots.length > 256 || value.projects.length > 256 || value.shells.length > 256) return null;
  const roots: FleetStatus['roots'][number][] = [];
  const projects: FleetStatus['projects'][number][] = [];
  const shells: FleetStatus['shells'][number][] = [];
  const rootIds = new Set<number>();
  const projectIds = new Set<number>();
  const shellIds = new Set<string>();
  for (const item of value.roots) {
    if (!validIdentity(item, ['id', 'name']) || rootIds.has(item.id)) return null;
    rootIds.add(item.id);
    roots.push({ id: item.id, name: item.name });
  }
  for (const item of value.projects) {
    if (!validIdentity(item, ['id', 'rootId', 'name']) ||
      !index(item.rootId) || item.rootId < 1 || projectIds.has(item.id)) return null;
    projectIds.add(item.id);
    projects.push({ id: item.id, rootId: item.rootId, name: item.name });
  }
  for (const item of value.shells) {
    if (!record(item) || !keys(item, ['projectId', 'shellIndex', 'agent', 'state',
      'launchName', 'pinned', 'startedAt', 'lastActiveAt']) ||
      Object.keys(item).length !== 8 || !index(item.projectId) ||
      item.projectId < 1 || !index(item.shellIndex) ||
      !text(item.launchName, 160) || /[\/\\\p{Cc}]/u.test(item.launchName) ||
      typeof item.pinned !== 'boolean' || !timestamp(item.startedAt) || !timestamp(item.lastActiveAt)) return null;
    if (item.agent !== null && item.agent !== 'claude' && item.agent !== 'omp') return null;
    if (item.state !== 'idle' && item.state !== 'busy' && item.state !== 'blocked') return null;
    const identity = `${item.projectId}:${item.shellIndex}`;
    if (shellIds.has(identity)) return null;
    shellIds.add(identity);
    shells.push({ projectId: item.projectId, shellIndex: item.shellIndex,
      agent: item.agent, state: item.state, launchName: item.launchName,
      pinned: item.pinned, startedAt: item.startedAt, lastActiveAt: item.lastActiveAt });
  }
  return { roots, projects, shells };
}

export interface StatusPage {
  readonly roots: FleetStatus['roots'];
  readonly rootOffset: number;
  readonly rootTotal: number;
  readonly projects: FleetStatus['projects'];
  readonly shells: FleetStatus['shells'];
  readonly projectOffset: number;
  readonly shellOffset: number;
  readonly projectTotal: number;
  readonly shellTotal: number;
  readonly token: string;
}

/** Validates one exact status slice and its offsets before aggregating peer data. */
export function validateStatusPage(value: unknown): StatusPage | null {
  if (!record(value) ||
    !keys(value, ['roots', 'projects', 'shells', 'rootOffset', 'projectOffset',
      'shellOffset', 'rootTotal', 'projectTotal', 'shellTotal', 'token']) ||
    Object.keys(value).length !== 10 ||
    !index(value.rootOffset) || !index(value.projectOffset) || !index(value.shellOffset) ||
    !index(value.rootTotal) || !index(value.projectTotal) || !index(value.shellTotal) ||
    value.rootTotal > 256 || value.projectTotal > 256 || value.shellTotal > 256 ||
    value.rootOffset > value.rootTotal || value.projectOffset > value.projectTotal ||
    value.shellOffset > value.shellTotal || !hex(value.token, 32)) return null;
  const status = validateStatusRows({
    roots: value.roots, projects: value.projects, shells: value.shells,
  });
  if (!status ||
    status.roots.length !== Math.min(ROOT_PAGE_SIZE, value.rootTotal - value.rootOffset) ||
    status.projects.length !== Math.min(STATUS_PAGE_SIZE, value.projectTotal - value.projectOffset) ||
    status.shells.length !== Math.min(STATUS_PAGE_SIZE, value.shellTotal - value.shellOffset)) return null;
  return {
    ...status,
    rootOffset: value.rootOffset,
    projectOffset: value.projectOffset,
    shellOffset: value.shellOffset,
    rootTotal: value.rootTotal,
    projectTotal: value.projectTotal,
    shellTotal: value.shellTotal,
    token: value.token,
  };
}
/** Bounds terminal snapshots before data leaves the peer or reaches the renderer. */
export function validateSnapshot(value: unknown): { output: string; alive: boolean } | null {
  if (
    !record(value) ||
    !keys(value, ['output', 'alive']) ||
    Object.keys(value).length !== 2 ||
    typeof value.output !== 'string' ||
    Buffer.byteLength(value.output, 'utf8') > 8192 ||
    typeof value.alive !== 'boolean'
  )
    return null;
  return { output: value.output, alive: value.alive };
}
