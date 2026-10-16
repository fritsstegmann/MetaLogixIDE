/**
 * `useGitStatus` applies only the latest `git:status` response for the current project (gate M2): a
 * response, or a failure, from a superseded request or a previous project is dropped. The hook runs
 * under a minimal in-test hook runtime (vitest runs in node, without a DOM renderer) that keeps
 * state, refs, callbacks and effects with React's dependency semantics.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GitStatusView } from '@renderer/hooks/useGitStatus';

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

type Call = { projectId: number; resolve: (v: GitStatusView) => void; reject: (e: unknown) => void };
const calls: Call[] = [];
vi.mock('@renderer/api', () => ({
  api: {
    invoke: vi.fn((_channel: string, req: { projectId: number }) =>
      new Promise((resolve, reject) => { calls.push({ projectId: req.projectId, resolve, reject }); })),
  },
}));

const { useGitStatus } = await import('@renderer/hooks/useGitStatus');
const { api } = await import('@renderer/api');

const view = (branch: string): GitStatusView => ({ isRepo: true, branch, ahead: 0, behind: 0, files: { 'a.ts': 'M' }, dirty: true });
const EMPTY: GitStatusView = { isRepo: false, branch: null, ahead: 0, behind: 0, files: {}, dirty: false };
const call = (i: number): Call => {
  const c = calls[i];
  if (!c) throw new Error(`no request #${i}`);
  return c;
};
const flush = () => new Promise((r) => setTimeout(r, 0));

function mount(initial: number | null) {
  let projectId = initial;
  let out = rt.render(() => useGitStatus(projectId, 4000));
  return {
    rerender(next: number | null) { projectId = next; out = rt.render(() => useGitStatus(projectId, 4000)); },
    status() { out = rt.render(() => useGitStatus(projectId, 4000)); return out.status; },
    refresh: () => out.refresh(),
  };
}

beforeEach(() => {
  rt.reset();
  calls.length = 0;
  vi.mocked(api.invoke).mockClear();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.stubGlobal('window', globalThis);
});

afterEach(() => {
  rt.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useGitStatus across a project switch', () => {
  it('shows the new project status when the previous project answers last', async () => {
    const h = mount(1);
    h.rerender(2);
    expect(calls.map((c) => c.projectId)).toEqual([1, 2]);
    call(1).resolve(view('two'));
    await flush();
    call(0).resolve(view('one'));
    await flush();
    expect(h.status()).toEqual(view('two'));
  });

  it('shows the new project status when it answers last (positive control)', async () => {
    const h = mount(1);
    h.rerender(2);
    call(0).resolve(view('one'));
    await flush();
    call(1).resolve(view('two'));
    await flush();
    expect(h.status()).toEqual(view('two'));
  });

  it('ignores a late failure from the previous project', async () => {
    const h = mount(1);
    h.rerender(2);
    call(1).resolve(view('two'));
    await flush();
    call(0).reject(new Error('gone'));
    await flush();
    expect(h.status()).toEqual(view('two'));
  });

  it('ignores a late response after the project is cleared', async () => {
    const h = mount(1);
    h.rerender(null);
    call(0).resolve(view('one'));
    await flush();
    expect(h.status()).toEqual(EMPTY);
  });
});

describe('useGitStatus for overlapping requests of one project', () => {
  it('keeps the newest refresh result when an older one answers last', async () => {
    const h = mount(1);
    void h.refresh();
    expect(calls).toHaveLength(2);
    call(1).resolve(view('new'));
    await flush();
    call(0).resolve(view('old'));
    await flush();
    expect(h.status()).toEqual(view('new'));
  });

  it('applies a failure of the latest request as empty status', async () => {
    const h = mount(1);
    call(0).resolve(view('one'));
    await flush();
    void h.refresh();
    call(1).reject(new Error('boom'));
    await flush();
    expect(h.status()).toEqual(EMPTY);
  });

  it('does not let an older failure clear a newer result', async () => {
    const h = mount(1);
    void h.refresh();
    call(1).resolve(view('new'));
    await flush();
    call(0).reject(new Error('late'));
    await flush();
    expect(h.status()).toEqual(view('new'));
  });

  it('polls every interval once the previous poll has settled', async () => {
    mount(1);
    call(0).resolve(view('one'));
    await flush();
    vi.advanceTimersByTime(4000);
    expect(calls).toHaveLength(2);
    expect(call(1).projectId).toBe(1);
  });

  it('skips a poll tick while a request is in flight, so a slow status is not starved', async () => {
    const h = mount(1);
    vi.advanceTimersByTime(4000);
    expect(calls).toHaveLength(1);
    call(0).resolve(view('slow'));
    await flush();
    expect(h.status()).toEqual(view('slow'));
  });

  it('starts a fresh request on refresh even while one is in flight', () => {
    const h = mount(1);
    void h.refresh();
    expect(calls).toHaveLength(2);
  });
});
