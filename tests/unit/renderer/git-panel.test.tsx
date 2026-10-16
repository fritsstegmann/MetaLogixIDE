/**
 * The Git panel's `usePanelStatus` applies only the latest `git:panel-status` response for the current
 * project (gate M2): a response, or a failure, from a superseded request or a previous project is
 * dropped, so the panel lists never show another project's files. The hook runs under a minimal
 * in-test hook runtime (vitest runs in node, without a DOM renderer) with React's dependency semantics.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IpcContract } from '@shared/ipc-contract';

type PanelStatus = IpcContract['git:panel-status']['response'];

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
    useRef<R>(init: R) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: init };
      return slots[i] as { current: R };
    },
    useCallback<F>(fn: F, deps: unknown[]) {
      const i = cursor++;
      const prev = slots[i] as { fn: F; deps: unknown[] } | undefined;
      if (prev && !changed(prev.deps, deps)) return prev.fn;
      slots[i] = { fn, deps };
      return fn;
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
  useRef: rt.useRef,
  useCallback: rt.useCallback,
  useEffect: rt.useEffect,
}));

type Call = { projectId: number; resolve: (v: PanelStatus) => void; reject: (e: unknown) => void };
const calls: Call[] = [];
vi.mock('@renderer/api', () => ({
  api: {
    invoke: vi.fn((_channel: string, req: { projectId: number }) =>
      new Promise((resolve, reject) => { calls.push({ projectId: req.projectId, resolve, reject }); })),
  },
}));

const { usePanelStatus } = await import('@renderer/components/GitPanel');

const panel = (branch: string): PanelStatus => ({
  isRepo: true, branch, ahead: 0, behind: 0, staged: [], unstaged: [{ path: `${branch}.ts`, status: 'M' }], untracked: [],
});
const call = (i: number): Call => {
  const c = calls[i];
  if (!c) throw new Error(`no request #${i}`);
  return c;
};
const flush = () => new Promise((r) => setTimeout(r, 0));

function mount(initial: number | null) {
  let projectId = initial;
  let out = rt.render(() => usePanelStatus(projectId));
  return {
    rerender(next: number | null) { projectId = next; out = rt.render(() => usePanelStatus(projectId)); },
    status() { out = rt.render(() => usePanelStatus(projectId)); return out.status; },
    refresh: () => out.refresh(),
  };
}

beforeEach(() => {
  rt.reset();
  calls.length = 0;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.stubGlobal('window', globalThis);
});

afterEach(() => {
  rt.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('usePanelStatus across a project switch', () => {
  it('shows the new project lists when the previous project answers last', async () => {
    const h = mount(1);
    h.rerender(2);
    expect(calls.map((c) => c.projectId)).toEqual([1, 2]);
    call(1).resolve(panel('two'));
    await flush();
    call(0).resolve(panel('one'));
    await flush();
    expect(h.status()).toEqual(panel('two'));
  });

  it('shows the new project lists when it answers last (positive control)', async () => {
    const h = mount(1);
    h.rerender(2);
    call(0).resolve(panel('one'));
    await flush();
    call(1).resolve(panel('two'));
    await flush();
    expect(h.status()).toEqual(panel('two'));
  });

  it('ignores a late failure from the previous project', async () => {
    const h = mount(1);
    h.rerender(2);
    call(1).resolve(panel('two'));
    await flush();
    call(0).reject(new Error('gone'));
    await flush();
    expect(h.status()).toEqual(panel('two'));
  });

  it('ignores a late response after the project is cleared', async () => {
    const h = mount(1);
    h.rerender(null);
    call(0).resolve(panel('one'));
    await flush();
    expect(h.status()).toBeNull();
  });
});

describe('usePanelStatus for overlapping requests of one project', () => {
  it('keeps the newest refresh result when an older one answers last', async () => {
    const h = mount(1);
    void h.refresh();
    expect(calls).toHaveLength(2);
    call(1).resolve(panel('new'));
    await flush();
    call(0).resolve(panel('old'));
    await flush();
    expect(h.status()).toEqual(panel('new'));
  });

  it('clears the status when the latest request fails', async () => {
    const h = mount(1);
    call(0).resolve(panel('one'));
    await flush();
    void h.refresh();
    call(1).reject(new Error('boom'));
    await flush();
    expect(h.status()).toBeNull();
  });

  it('does not let an older failure clear a newer result', async () => {
    const h = mount(1);
    void h.refresh();
    call(1).resolve(panel('new'));
    await flush();
    call(0).reject(new Error('late'));
    await flush();
    expect(h.status()).toEqual(panel('new'));
  });

  it('polls every 3s once the previous poll has settled', async () => {
    mount(1);
    call(0).resolve(panel('one'));
    await flush();
    vi.advanceTimersByTime(2999);
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(calls).toHaveLength(2);
    expect(call(1).projectId).toBe(1);
  });

  it('skips a poll tick while a request is in flight, so a slow status is not starved', async () => {
    const h = mount(1);
    vi.advanceTimersByTime(3000);
    expect(calls).toHaveLength(1);
    call(0).resolve(panel('slow'));
    await flush();
    expect(h.status()).toEqual(panel('slow'));
  });

  it('starts a fresh request on refresh even while one is in flight', () => {
    const h = mount(1);
    void h.refresh();
    expect(calls).toHaveLength(2);
  });
});
