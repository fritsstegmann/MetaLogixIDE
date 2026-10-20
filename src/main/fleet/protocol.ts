/** Strict fleet wire validation keeps discovery public and control frames bounded. */
import { createHash } from 'node:crypto';
import type { FleetStatus } from '../../shared/fleet-contract';

export const MAX_FRAME = 16_384;
export const STATUS_PAGE_SIZE = 12;
export interface Beacon {
  readonly v: 1;
  readonly id: string;
  readonly name: string;
  readonly port: number;
}
export type Operation = 'status' | 'launch' | 'stop' | 'write' | 'snapshot';
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
    };

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

function validArgs(op: Operation, args: unknown): args is Record<string, unknown> {
  if (!record(args)) return false;
  if (op === 'status') {
    if (
      !keys(args, ['projectOffset', 'shellOffset', 'token']) ||
      !index(args.projectOffset) ||
      args.projectOffset > 256 ||
      !index(args.shellOffset) ||
      args.shellOffset > 256
    )
      return false;
    const initial = args.projectOffset === 0 && args.shellOffset === 0;
    return initial
      ? Object.keys(args).length === 2
      : Object.keys(args).length === 3 && hex(args.token, 32);
  }
  if (!index(args.projectId) || args.projectId < 1) return false;
  if (op === 'launch') return keys(args, ['projectId']) && Object.keys(args).length === 1;
  if (!index(args.shellIndex)) return false;
  if (op === 'write')
    return (
      keys(args, ['projectId', 'shellIndex', 'data']) &&
      Object.keys(args).length === 3 &&
      text(args.data, 8192)
    );
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
  if (value.type === 'request') {
    if (!keys(value, ['type', 'id', 'op', 'args']) || Object.keys(value).length !== 4) return null;
    if (
      value.op !== 'status' &&
      value.op !== 'launch' &&
      value.op !== 'stop' &&
      value.op !== 'write' &&
      value.op !== 'snapshot'
    )
      return null;
    if (!validArgs(value.op, value.args)) return null;
    return { type: 'request', id: value.id, op: value.op, args: value.args };
  }
  if (value.type === 'response') {
    if (!keys(value, ['type', 'id', 'ok', 'value']) || typeof value.ok !== 'boolean') return null;
    if (value.ok && !Object.hasOwn(value, 'value')) return null;
    if (!value.ok && Object.hasOwn(value, 'value')) return null;
    return value.ok
      ? { type: 'response', id: value.id, ok: true, value: value.value }
      : { type: 'response', id: value.id, ok: false };
  }
  return null;
}

/** Accepts only bounded status fields, without project paths or shell content. */
export function validateStatus(value: unknown): FleetStatus | null {
  if (
    !record(value) ||
    !keys(value, ['projects', 'shells']) ||
    Object.keys(value).length !== 2 ||
    !Array.isArray(value.projects) ||
    !Array.isArray(value.shells) ||
    value.projects.length > 256 ||
    value.shells.length > 256
  )
    return null;
  const projects: FleetStatus['projects'][number][] = [];
  const shells: FleetStatus['shells'][number][] = [];
  for (const item of value.projects) {
    if (
      !record(item) ||
      !keys(item, ['id', 'name']) ||
      Object.keys(item).length !== 2 ||
      !index(item.id) ||
      item.id < 1 ||
      !text(item.name, 160)
    )
      return null;
    projects.push({ id: item.id, name: item.name });
  }
  for (const item of value.shells) {
    if (
      !record(item) ||
      !keys(item, ['projectId', 'shellIndex', 'agent', 'state']) ||
      Object.keys(item).length !== 4 ||
      !index(item.projectId) ||
      item.projectId < 1 ||
      !index(item.shellIndex)
    )
      return null;
    if (item.agent !== null && item.agent !== 'claude' && item.agent !== 'omp') return null;
    if (item.state !== 'idle' && item.state !== 'busy' && item.state !== 'blocked') return null;
    shells.push({
      projectId: item.projectId,
      shellIndex: item.shellIndex,
      agent: item.agent,
      state: item.state,
    });
  }
  return { projects, shells };
}

export interface StatusPage {
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
  if (
    !record(value) ||
    !keys(value, [
      'projects',
      'shells',
      'projectOffset',
      'shellOffset',
      'projectTotal',
      'shellTotal',
      'token',
    ]) ||
    Object.keys(value).length !== 7 ||
    !index(value.projectOffset) ||
    !index(value.shellOffset) ||
    !index(value.projectTotal) ||
    !index(value.shellTotal) ||
    value.projectTotal > 256 ||
    value.shellTotal > 256 ||
    value.projectOffset > value.projectTotal ||
    value.shellOffset > value.shellTotal ||
    !hex(value.token, 32)
  )
    return null;
  const status = validateStatus({ projects: value.projects, shells: value.shells });
  if (
    !status ||
    status.projects.length !==
      Math.min(STATUS_PAGE_SIZE, value.projectTotal - value.projectOffset) ||
    status.shells.length !== Math.min(STATUS_PAGE_SIZE, value.shellTotal - value.shellOffset)
  )
    return null;
  return {
    ...status,
    projectOffset: value.projectOffset,
    shellOffset: value.shellOffset,
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
