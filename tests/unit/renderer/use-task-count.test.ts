/**
 * `useTaskCount` (AC23, AC24): the count is keyed by project so it reads 0 the moment the project
 * changes, a reply for a previous project is dropped, a rejection gives 0, and the render returns
 * before discovery resolves. Runs under a minimal in-test hook runtime (vitest env is node).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TasksDiscovery } from '@shared/tasks-contract';

const rt = vi.hoisted(() => {
  type Effect = { deps?: unknown[]; cleanup?: () => void; run?: () => unknown };
  const slots: unknown[] = [];
  const effects: Effect[] = [];
  let cursor = 0;
  let effectCursor = 0;
  const changed = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  return {
    reset() { slots.length = 0; effects.length = 0; },
    render<T>(fn: () => T): T {
      cursor = 0;
      effectCursor = 0;
      const out = fn();
      const due = effects.filter((e) => e.run);
      for (const e of due) e.cleanup?.();
      for (const e of due) {
        const c = e.run?.();
        e.run = undefined;
        e.cleanup = typeof c === 'function' ? (c as () => void) : undefined;
      }
      return out;
    },
    unmount() { for (const e of effects) e.cleanup?.(); },
    useState<S>(init: S) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = init;
      const set = (v: S | ((p: S) => S)) => { slots[i] = typeof v === 'function' ? (v as (p: S) => S)(slots[i] as S) : v; };
      return [slots[i] as S, set] as const;
    },
    useEffect(run: () => unknown, deps?: unknown[]) {
      const i = effectCursor++;
      const prev = effects[i];
      if (prev && !changed(prev.deps, deps)) return;
      effects[i] = { deps, cleanup: prev?.cleanup, run };
    },
  };
});

vi.mock('react', async (orig) => ({
  ...(await orig<typeof import('react')>()),
  useState: rt.useState,
  useEffect: rt.useEffect,
}));

type Call = { projectId: number; resolve: (v: TasksDiscovery) => void; reject: (e: unknown) => void };
const calls: Call[] = [];
vi.mock('@renderer/api', () => ({
  api: {
    invoke: vi.fn((_channel: string, req: { projectId: number }) =>
      new Promise((resolve, reject) => { calls.push({ projectId: req.projectId, resolve, reject }); })),
  },
}));

const { useTaskCount } = await import('@renderer/hooks/useTaskCount');

const reply = (n: number): TasksDiscovery => ({
  tasks: Array.from({ length: n }, (_, i) => ({ id: `npm:t${i}`, source: 'npm' as const, name: `t${i}`, command: ['npm'] })),
  notices: [],
});
const call = (i: number): Call => {
  const c = calls[i];
  if (!c) throw new Error(`no request #${i}`);
  return c;
};
const flush = () => new Promise((r) => setTimeout(r, 0));

function mount(initial: number | null) {
  let projectId = initial;
  const draw = () => rt.render(() => useTaskCount(projectId));
  let out = draw();
  return {
    out: () => out,
    rerender(next: number | null) { projectId = next; out = draw(); },
    count() { out = draw(); return out; },
  };
}

beforeEach(() => { rt.reset(); calls.length = 0; });
afterEach(() => { rt.unmount(); });

describe('useTaskCount', () => {
  it('returns before discovery resolves, reading 0 (AC23)', () => {
    const h = mount(1);
    expect(h.out()).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('shows the resolved length for the current project', async () => {
    const h = mount(1);
    call(0).resolve(reply(3));
    await flush();
    expect(h.count()).toBe(3);
  });

  it('reads 0 synchronously on a project change, before the new reply', async () => {
    const h = mount(1);
    call(0).resolve(reply(3));
    await flush();
    expect(h.count()).toBe(3);
    h.rerender(2);
    expect(h.out()).toBe(0);
  });

  it('drops a reply for a previous project that arrives last', async () => {
    const h = mount(1);
    h.rerender(2);
    call(1).resolve(reply(2));
    await flush();
    call(0).resolve(reply(9));
    await flush();
    expect(h.count()).toBe(2);
  });

  it('gives 0 when discovery rejects', async () => {
    const h = mount(1);
    call(0).reject(new Error('boom'));
    await flush();
    expect(h.count()).toBe(0);
  });

  it('gives 0 and makes no request with no project', () => {
    const h = mount(null);
    expect(h.out()).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
