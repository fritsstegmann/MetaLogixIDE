/**
 * Ctrl+1 to Ctrl+9, anywhere in the main window (a focused terminal included), open the matching
 * In use session: this machine's live projects in the Sidebar's In use order, then the paired
 * machines' live projects. The Sidebar, the command palette's In use hints and the global key all
 * number sessions from the one ordered list built here, so Ctrl+n always means the same row.
 */
import type { RemoteInUseRow } from './fleet-in-use';

/** Ctrl+1 to Ctrl+<this> jump; later sessions have no key. */
export const IN_USE_JUMP_MAX = 9;

/** One In use session a jump can open. */
export type InUseTarget =
  | { readonly kind: 'local'; readonly projectId: number }
  | { readonly kind: 'remote'; readonly row: RemoteInUseRow };

interface JumpKeyLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** The 1-based session number for a bare Ctrl+1–9 keydown, or `null` for any other key or modifier. */
export function inUseJumpNumber(e: JumpKeyLike): number | null {
  if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || !/^[1-9]$/.test(e.key)) return null;
  return Number(e.key);
}

/** Stable key of a target, shared by the Sidebar, palette and global jump lookups. */
export function inUseTargetKey(t: InUseTarget): string {
  return t.kind === 'local' ? `local:${t.projectId}` : `remote:${t.row.deviceId}:${t.row.projectId}`;
}

/** Each target's 1-based jump number, for the first `IN_USE_JUMP_MAX` targets only. */
export function inUseJumpNumbers(targets: readonly InUseTarget[]): ReadonlyMap<string, number> {
  return new Map(targets.slice(0, IN_USE_JUMP_MAX).map((t, i) => [inUseTargetKey(t), i + 1]));
}

/** First-seen sequence numbers for live project ids: ids keep their number while alive and lose it when they stop. */
export interface InUseSequence {
  readonly seq: ReadonlyMap<number, number>;
  readonly next: number;
}

/**
 * The next sequence after `aliveIds` changed: new ids are numbered in ascending id order after every
 * existing one, gone ids are dropped. Returns `prev` itself when nothing changed.
 */
export function advanceInUseSequence(prev: InUseSequence, aliveIds: ReadonlySet<number>): InUseSequence {
  const added = [...aliveIds].filter((id) => !prev.seq.has(id)).sort((a, b) => a - b);
  const removed = [...prev.seq.keys()].some((id) => !aliveIds.has(id));
  if (added.length === 0 && !removed) return prev;
  const seq = new Map([...prev.seq].filter(([id]) => aliveIds.has(id)));
  let next = prev.next;
  for (const id of added) seq.set(id, next++);
  return { seq, next };
}

/** This machine's live project ids in In use order (first seen alive first), limited to `known` project ids. */
export function orderedLocalInUse(sequence: InUseSequence, known: ReadonlySet<number>): number[] {
  return [...sequence.seq].filter(([id]) => known.has(id)).sort((a, b) => a[1] - b[1]).map(([id]) => id);
}
