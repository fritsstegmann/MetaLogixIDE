import { describe, expect, it } from 'vitest';
import { createPendingKills } from '@renderer/pending-kill';

describe('pending kills', () => {
  it('takes a marked shell on its own exit', () => {
    const p = createPendingKills();
    p.mark(7, 2);
    expect(p.takeIfPending(7, 2)).toBe(true);
  });

  it('does not take a shell that exited without being marked (To tab)', () => {
    const p = createPendingKills();
    p.mark(7, 2);
    expect(p.takeIfPending(7, 3)).toBe(false);
    expect(p.takeIfPending(8, 2)).toBe(false);
    expect(p.takeIfPending(7, 2)).toBe(true);
  });

  it('treats a second exit for the same shell as a no-op', () => {
    const p = createPendingKills();
    p.mark(7, 2);
    expect(p.takeIfPending(7, 2)).toBe(true);
    expect(p.takeIfPending(7, 2)).toBe(false);
  });

  it('flushes every pending shell exactly once', () => {
    const p = createPendingKills();
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
    const p = createPendingKills();
    p.mark(7, 2);
    p.mark(7, 4);
    p.takeIfPending(7, 2);
    expect(p.flushAll()).toEqual([{ projectId: 7, shellIndex: 4 }]);
  });

  it('marks a shell once however often it is marked', () => {
    const p = createPendingKills();
    p.mark(7, 2);
    p.mark(7, 2);
    expect(p.flushAll()).toEqual([{ projectId: 7, shellIndex: 2 }]);
  });
});
