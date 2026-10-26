/**
 * Remote-session hooks: `useFleetGitStatus` polls the peer's git summary and hides it on failure,
 * `useFleetViewing` reports the shown remote shell to main only on change, and `useRemoteShellFocus`
 * turns a validated `fleet:focus-remote-shell` broadcast into a remote project selection. Hooks run
 * under a minimal in-test hook runtime (vitest runs in node, without a DOM renderer).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FleetGitStatus,
  FleetShellRef,
  FleetState,
  FleetStatus,
} from '@shared/fleet-contract';

const rt = vi.hoisted(() => {
  type Effect = { deps?: unknown[]; cleanup?: () => void; run?: () => unknown };
  const slots: unknown[] = [];
  const effects: Effect[] = [];
  let cursor = 0;
  let effectCursor = 0;
  const changed = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  return {
    reset() {
      slots.length = 0;
      effects.length = 0;
    },
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
    unmount() {
      for (const e of effects) e.cleanup?.();
      effects.length = 0;
    },
    useState<S>(init: S | (() => S)) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof init === 'function' ? (init as () => S)() : init;
      const set = (v: S | ((p: S) => S)) => {
        slots[i] = typeof v === 'function' ? (v as (p: S) => S)(slots[i] as S) : v;
      };
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

type Pending = {
  channel: string;
  req: unknown;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
};
const calls: Pending[] = [];
const listeners = new Map<string, Set<(payload: unknown) => void>>();
vi.mock('@renderer/api', () => ({
  api: {
    invoke: vi.fn(
      (channel: string, req: unknown) =>
        new Promise((resolve, reject) => {
          calls.push({ channel, req, resolve, reject });
        }),
    ),
    on: vi.fn((channel: string, fn: (payload: unknown) => void) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(fn);
      listeners.set(channel, set);
      return () => {
        set.delete(fn);
      };
    }),
  },
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@renderer/hooks/useToasts', () => ({ toast }));

const { useFleetGitStatus, useFleetViewing, useRemoteShellFocus } =
  await import('@renderer/hooks/useRemoteSession');

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const of = (channel: string) => calls.filter((c) => c.channel === channel);
const emit = (channel: string, payload: unknown) => {
  for (const fn of listeners.get(channel) ?? []) fn(payload);
};

const visibility = { state: 'visible' as 'visible' | 'hidden', handlers: new Set<() => void>() };
function setHidden(hidden: boolean) {
  visibility.state = hidden ? 'hidden' : 'visible';
  for (const h of visibility.handlers) h();
}

const REPO: FleetGitStatus = {
  isRepo: true,
  branch: 'main',
  dirty: true,
  ahead: 2,
  behind: 1,
  changedCount: 3,
};

beforeEach(() => {
  rt.reset();
  calls.length = 0;
  listeners.clear();
  toast.mockReset();
  visibility.state = 'visible';
  visibility.handlers.clear();
  vi.stubGlobal('document', {
    get visibilityState() {
      return visibility.state;
    },
    addEventListener: (type: string, h: () => void) => {
      if (type === 'visibilitychange') visibility.handlers.add(h);
    },
    removeEventListener: (type: string, h: () => void) => {
      if (type === 'visibilitychange') visibility.handlers.delete(h);
    },
  });
  vi.stubGlobal('window', {
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  });
});
afterEach(() => {
  rt.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useFleetGitStatus', () => {
  const target = { peerId: 'peer-b', projectId: 7 };

  it('asks the hosting peer for git status and returns its summary', async () => {
    const render = () => rt.render(() => useFleetGitStatus(target));
    expect(render().isRepo).toBe(false);
    expect(of('fleet:git-status').map((c) => c.req)).toEqual([{ peerId: 'peer-b', projectId: 7 }]);
    expect(of('git:status')).toHaveLength(0);
    of('fleet:git-status')[0]!.resolve(REPO);
    await flush();
    expect(render()).toEqual(REPO);
  });

  it('hides git (isRepo false) when the request rejects, after a prior success showed it', async () => {
    vi.useFakeTimers();
    const render = () => rt.render(() => useFleetGitStatus(target));
    render();
    of('fleet:git-status')[0]!.resolve(REPO);
    await flush();
    expect(render().isRepo).toBe(true);
    vi.advanceTimersByTime(4000);
    expect(of('fleet:git-status')).toHaveLength(2);
    of('fleet:git-status')[1]!.reject(new Error('peer offline'));
    await flush();
    expect(render().isRepo).toBe(false);
  });

  it('makes no request and stays empty for a null target', () => {
    const out = rt.render(() => useFleetGitStatus(null));
    expect(out.isRepo).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('polls every 4s, skips a tick while a request is in flight or the window is hidden', async () => {
    vi.useFakeTimers();
    const render = () => rt.render(() => useFleetGitStatus(target));
    render();
    vi.advanceTimersByTime(4000);
    expect(of('fleet:git-status')).toHaveLength(1);
    of('fleet:git-status')[0]!.resolve(REPO);
    await flush();
    vi.advanceTimersByTime(4000);
    expect(of('fleet:git-status')).toHaveLength(2);
    of('fleet:git-status')[1]!.resolve(REPO);
    await flush();
    visibility.state = 'hidden';
    vi.advanceTimersByTime(8000);
    expect(of('fleet:git-status')).toHaveLength(2);
    visibility.state = 'visible';
    vi.advanceTimersByTime(4000);
    expect(of('fleet:git-status')).toHaveLength(3);
  });

  it('drops a late answer for a previous project', async () => {
    let current = target;
    const render = () => rt.render(() => useFleetGitStatus(current));
    render();
    current = { peerId: 'peer-b', projectId: 8 };
    render();
    expect(of('fleet:git-status').map((c) => c.req)).toEqual([target, current]);
    of('fleet:git-status')[0]!.resolve(REPO);
    await flush();
    expect(render().isRepo).toBe(false);
    of('fleet:git-status')[1]!.resolve({ ...REPO, branch: 'dev' });
    await flush();
    expect(render().branch).toBe('dev');
  });
});

describe('useFleetViewing', () => {
  const shell: FleetShellRef = { peerId: 'peer-b', projectId: 7, shellIndex: 2 };
  const sent = () => of('fleet:viewing').map((c) => c.req);

  it('sends the shown shell once, again only when it changes, and null when none is shown', () => {
    let current: FleetShellRef | null = null;
    const render = () => rt.render(() => useFleetViewing(current));
    render();
    expect(sent()).toEqual([{ shell: null }]);
    current = shell;
    render();
    current = { ...shell };
    render();
    expect(sent()).toEqual([{ shell: null }, { shell }]);
    current = { ...shell, shellIndex: 3 };
    render();
    current = null;
    render();
    expect(sent()).toEqual([
      { shell: null },
      { shell },
      { shell: { ...shell, shellIndex: 3 } },
      { shell: null },
    ]);
  });

  it('reports null on a fresh mount so main forgets a shell a reloaded window no longer shows', () => {
    rt.render(() => useFleetViewing(null));
    expect(sent()).toEqual([{ shell: null }]);
    rt.render(() => useFleetViewing(null));
    expect(sent()).toHaveLength(1);
  });

  it('reports null while the window is hidden and the shell again when it returns', () => {
    const render = () => rt.render(() => useFleetViewing(shell));
    render();
    expect(sent()).toEqual([{ shell }]);
    setHidden(true);
    render();
    expect(sent()).toEqual([{ shell }, { shell: null }]);
    setHidden(false);
    render();
    expect(sent()).toEqual([{ shell }, { shell: null }, { shell }]);
  });

  it('resends after a failed send once the shell changes back', async () => {
    let current: FleetShellRef | null = shell;
    const render = () => rt.render(() => useFleetViewing(current));
    render();
    of('fleet:viewing')[0]!.reject(new Error('main busy'));
    await flush();
    current = null;
    render();
    expect(sent()).toEqual([{ shell }, { shell: null }]);
  });
});

describe('useRemoteShellFocus', () => {
  const linked: FleetState = {
    enabled: true,
    port: 1,
    controls: [],
    peers: [
      { id: 'peer-b', name: 'Build Mac', status: 'linked' },
      { id: 'peer-c', name: 'Old Box', status: 'offline' },
    ],
  };
  const status: FleetStatus = {
    roots: [],
    projects: [{ id: 7, rootId: 1, name: 'Service' }],
    shells: [],
  };
  const good: FleetShellRef = { peerId: 'peer-b', projectId: 7, shellIndex: 2 };

  function mount(state: FleetState | null = linked) {
    const onFocus = vi.fn();
    let current = state;
    const render = () => rt.render(() => useRemoteShellFocus(current, onFocus));
    render();
    return {
      onFocus,
      render,
      setState(next: FleetState | null) {
        current = next;
        render();
      },
    };
  }

  it.each([
    ['null', null],
    ['a string', 'peer-b'],
    ['a missing shellIndex', { peerId: 'peer-b', projectId: 7 }],
    ['an empty peerId', { peerId: '', projectId: 7, shellIndex: 2 }],
    ['a negative shellIndex', { peerId: 'peer-b', projectId: 7, shellIndex: -1 }],
    ['a fractional projectId', { peerId: 'peer-b', projectId: 7.5, shellIndex: 2 }],
    ['a numeric peerId', { peerId: 4, projectId: 7, shellIndex: 2 }],
  ])('ignores a malformed payload (%s) and still honours a valid one', async (_label, payload) => {
    const { onFocus } = mount();
    emit('fleet:focus-remote-shell', payload);
    await flush();
    expect(of('fleet:status')).toHaveLength(0);
    expect(onFocus).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    emit('fleet:focus-remote-shell', good);
    of('fleet:status')[0]!.resolve(status);
    await flush();
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it('opens the project with its names and the requested shell', async () => {
    const { onFocus } = mount();
    emit('fleet:focus-remote-shell', good);
    expect(of('fleet:status').map((c) => c.req)).toEqual([{ peerId: 'peer-b' }]);
    of('fleet:status')[0]!.resolve(status);
    await flush();
    expect(onFocus).toHaveBeenCalledWith(
      { peerId: 'peer-b', peerName: 'Build Mac', projectId: 7, projectName: 'Service' },
      2,
    );
    expect(toast).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown peer', { ...good, peerId: 'peer-x' }],
    ['a peer that is not linked', { ...good, peerId: 'peer-c' }],
  ])('tells the user and opens nothing for %s', async (_label, payload) => {
    const { onFocus } = mount();
    emit('fleet:focus-remote-shell', payload);
    await flush();
    expect(of('fleet:status')).toHaveLength(0);
    expect(onFocus).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      'Could not open the remote shell',
      expect.objectContaining({ kind: 'error' }),
    );
  });

  it('tells the user and opens nothing when Fleet state is not loaded', async () => {
    const { onFocus } = mount(null);
    emit('fleet:focus-remote-shell', good);
    await flush();
    expect(onFocus).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('tells the user and opens nothing for a project the peer no longer lists', async () => {
    const { onFocus } = mount();
    emit('fleet:focus-remote-shell', { ...good, projectId: 99 });
    of('fleet:status')[0]!.resolve(status);
    await flush();
    expect(onFocus).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      'Could not open the remote shell',
      expect.objectContaining({ kind: 'error' }),
    );
  });

  it('tells the user and opens nothing when the peer status request rejects', async () => {
    const { onFocus } = mount();
    emit('fleet:focus-remote-shell', good);
    of('fleet:status')[0]!.reject(new Error('timeout'));
    await flush();
    expect(onFocus).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('reads the latest Fleet state, not the one at subscription time', async () => {
    const { onFocus, setState } = mount({ ...linked, peers: [] });
    setState(linked);
    emit('fleet:focus-remote-shell', good);
    of('fleet:status')[0]!.resolve(status);
    await flush();
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it('applies only the newest of two overlapping focus requests', async () => {
    const { onFocus } = mount();
    emit('fleet:focus-remote-shell', good);
    emit('fleet:focus-remote-shell', { ...good, shellIndex: 4 });
    of('fleet:status')[1]!.resolve(status);
    await flush();
    of('fleet:status')[0]!.resolve(status);
    await flush();
    expect(onFocus.mock.calls.map((c) => c[1])).toEqual([4]);
  });

  it('stops listening on unmount', () => {
    mount();
    expect(listeners.get('fleet:focus-remote-shell')?.size).toBe(1);
    rt.unmount();
    expect(listeners.get('fleet:focus-remote-shell')?.size).toBe(0);
  });
});
