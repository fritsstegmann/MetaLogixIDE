/**
 * The global In use jump (Ctrl+1–9): which keys count, how this machine's live projects keep a
 * stable first-seen order, and how the shared list numbers local then remote sessions.
 */
import { describe, it, expect } from 'vitest';
import {
  IN_USE_JUMP_MAX,
  advanceInUseSequence,
  inUseJumpNumber,
  inUseJumpNumbers,
  inUseTargetKey,
  orderedLocalInUse,
  type InUseSequence,
  type InUseTarget,
} from '@renderer/in-use-jump';

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ key: k, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe('inUseJumpNumber', () => {
  it('reads bare Ctrl+1 to Ctrl+9', () => {
    expect([1, 2, 5, 9].map((n) => inUseJumpNumber(key(String(n))))).toEqual([1, 2, 5, 9]);
  });

  it('ignores Ctrl+0, other keys, extra modifiers and no Ctrl', () => {
    expect(inUseJumpNumber(key('0'))).toBeNull();
    expect(inUseJumpNumber(key('a'))).toBeNull();
    expect(inUseJumpNumber(key('10'))).toBeNull();
    expect(inUseJumpNumber(key('1', { shiftKey: true }))).toBeNull();
    expect(inUseJumpNumber(key('1', { altKey: true }))).toBeNull();
    expect(inUseJumpNumber(key('1', { metaKey: true }))).toBeNull();
    expect(inUseJumpNumber(key('1', { ctrlKey: false }))).toBeNull();
  });
});

describe('advanceInUseSequence / orderedLocalInUse', () => {
  const start: InUseSequence = { seq: new Map(), next: 1 };

  it('numbers new ids after existing ones and keeps an id\'s place while it stays alive', () => {
    const a = advanceInUseSequence(start, new Set([5, 2]));
    expect(orderedLocalInUse(a, new Set([2, 5]))).toEqual([2, 5]);
    const b = advanceInUseSequence(a, new Set([5, 2, 1]));
    expect(orderedLocalInUse(b, new Set([1, 2, 5]))).toEqual([2, 5, 1]);
  });

  it('drops an id that stops and puts it last when it comes back', () => {
    const a = advanceInUseSequence(start, new Set([1, 2, 3]));
    const b = advanceInUseSequence(a, new Set([2, 3]));
    const c = advanceInUseSequence(b, new Set([1, 2, 3]));
    expect(orderedLocalInUse(c, new Set([1, 2, 3]))).toEqual([2, 3, 1]);
  });

  it('returns the same object when the live set is unchanged', () => {
    const a = advanceInUseSequence(start, new Set([1, 2]));
    expect(advanceInUseSequence(a, new Set([2, 1]))).toBe(a);
  });

  it('leaves out live ids that are not known projects', () => {
    const a = advanceInUseSequence(start, new Set([1, 2, 3]));
    expect(orderedLocalInUse(a, new Set([1, 3]))).toEqual([1, 3]);
  });
});

describe('inUseJumpNumbers', () => {
  const remote = (deviceId: string, projectId: number): InUseTarget =>
    ({ kind: 'remote', row: { deviceId, deviceName: deviceId, projectId, name: `p${projectId}`, state: 'idle' } });

  it('numbers local then remote targets from 1, keyed so a local and a remote project with the same id differ', () => {
    const targets: InUseTarget[] = [{ kind: 'local', projectId: 7 }, remote('studio', 7)];
    const numbers = inUseJumpNumbers(targets);
    expect(numbers.get(inUseTargetKey(targets[0]!))).toBe(1);
    expect(numbers.get(inUseTargetKey(targets[1]!))).toBe(2);
    expect(inUseTargetKey(targets[0]!)).not.toBe(inUseTargetKey(targets[1]!));
  });

  it('numbers only the first nine', () => {
    const targets = Array.from({ length: 12 }, (_, i): InUseTarget => ({ kind: 'local', projectId: i + 1 }));
    const numbers = inUseJumpNumbers(targets);
    expect(numbers.size).toBe(IN_USE_JUMP_MAX);
    expect(numbers.get('local:9')).toBe(9);
    expect(numbers.get('local:10')).toBeUndefined();
  });
});
