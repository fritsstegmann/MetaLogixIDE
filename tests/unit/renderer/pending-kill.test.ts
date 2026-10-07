import { describe, expect, it, vi } from 'vitest';
import { createPendingShells, killAndForget, type PendingShell } from '@renderer/pending-kill';

describe('pending shells', () => {
  it('takes a marked shell on its own exit', () => {
    const p = createPendingShells();
    p.mark(7, 2);
    expect(p.takeIfPending(7, 2)).toBe(true);
  });

  it('does not take a shell that exited without being marked (To tab)', () => {
    const p = createPendingShells();
    p.mark(7, 2);
    expect(p.takeIfPending(7, 3)).toBe(false);
    expect(p.takeIfPending(8, 2)).toBe(false);
    expect(p.takeIfPending(7, 2)).toBe(true);
  });

  it('treats a second exit for the same shell as a no-op', () => {
    const p = createPendingShells();
    p.mark(7, 2);
    expect(p.takeIfPending(7, 2)).toBe(true);
    expect(p.takeIfPending(7, 2)).toBe(false);
  });

  it('flushes every pending shell exactly once', () => {
    const p = createPendingShells();
    p.mark(7, 2);
    p.mark(7, 4);
    p.mark(9, 1);
    expect(p.flushAll()).toEqual([
      { projectId: 7, shellIndex: 2 },
      { projectId: 7, shellIndex: 4 },
      { projectId: 9, shellIndex: 1 },
    ]);
    expect(p.flushAll()).toEqual([]);
    expect(p.takeIfPending(7, 2)).toBe(false);
  });

  it('does not return a shell from a flush once its exit took it', () => {
    const p = createPendingShells();
    p.mark(7, 2);
    p.mark(7, 4);
    p.takeIfPending(7, 2);
    expect(p.flushAll()).toEqual([{ projectId: 7, shellIndex: 4 }]);
  });

  it('marks a shell once however often it is marked', () => {
    const p = createPendingShells();
    p.mark(7, 2);
    p.mark(7, 2);
    expect(p.flushAll()).toEqual([{ projectId: 7, shellIndex: 2 }]);
  });

  it('hides marked shells of its project, taken or not, until forgotten', () => {
    const p = createPendingShells();
    p.mark(7, 2);
    p.mark(7, 4);
    p.mark(9, 1);
    expect(p.hidden(7)).toEqual([2, 4]);
    p.takeIfPending(7, 2);
    expect(p.hidden(7)).toEqual([2, 4]);
    p.forget(7, 2);
    expect(p.hidden(7)).toEqual([4]);
    expect(p.hidden(9)).toEqual([1]);
  });

  it('keeps flushed shells hidden until forgotten', () => {
    const p = createPendingShells();
    p.mark(7, 2);
    p.flushAll();
    expect(p.hidden(7)).toEqual([2]);
    p.forget(7, 2);
    expect(p.hidden(7)).toEqual([]);
  });

  it("takes every still-pending shell of a project once its exits settle (AC48 leak)", () => {
    const p = createPendingShells();
    p.mark(7, 2);
    p.mark(7, 4);
    p.mark(9, 1);
    p.takeIfPending(7, 2);
    expect(p.takeAll(7)).toEqual([{ projectId: 7, shellIndex: 4 }]);
    expect(p.takeAll(7)).toEqual([]);
    expect(p.takeIfPending(7, 4)).toBe(false);
    expect(p.flushAll()).toEqual([{ projectId: 9, shellIndex: 1 }]);
  });
});

describe('killAndForget', () => {
  function deferred() {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }
  const shell: PendingShell = { projectId: 7, shellIndex: 2 };

  it('keeps the shell hidden while its kill is in flight and un-hides it once the kill resolves', async () => {
    const p = createPendingShells();
    p.mark(7, 2);
    p.takeIfPending(7, 2);
    const d = deferred();
    const kill = vi.fn(() => d.promise);
    const done = killAndForget(p, shell, kill);
    expect(kill).toHaveBeenCalledWith(shell);
    await Promise.resolve();
    expect(p.hidden(7)).toEqual([2]);
    d.resolve();
    await done;
    expect(p.hidden(7)).toEqual([]);
  });

  it('un-hides the shell when its kill fails, without throwing', async () => {
    const p = createPendingShells();
    p.mark(7, 2);
    const d = deferred();
    const done = killAndForget(p, shell, () => d.promise);
    d.reject(new Error('gone'));
    await expect(done).resolves.toBeUndefined();
    expect(p.hidden(7)).toEqual([]);
  });

  it('lets a shell that reuses the index show as soon as the kill has resolved', async () => {
    const p = createPendingShells();
    p.mark(7, 2);
    p.takeIfPending(7, 2);
    await killAndForget(p, shell, async () => undefined);
    p.mark(7, 3);
    expect(p.hidden(7)).toEqual([3]);
  });
});
