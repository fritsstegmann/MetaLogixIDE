/**
 * `useFrostTerminalAttribute` keeps the root's frosted-terminal attribute in sync with the stored
 * `frost_terminal` setting: it re-reads on mount and on every `settings:changed` for that key, and
 * ignores changes to other keys. The hook runs under a minimal in-test effect runtime (vitest runs
 * in node, without a DOM renderer), mirroring `tests/unit/renderer/use-git-status.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FROST_ATTR, MAC_PLATFORM } from '@renderer/frosted-chrome-contract';
import type { RootFlagTarget } from '@renderer/root-flags';

const rt = vi.hoisted(() => {
  type Effect = { deps?: unknown[]; cleanup?: () => void; run?: () => unknown };
  const effects: Effect[] = [];
  let effectCursor = 0;
  const changed = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  return {
    reset() { effects.length = 0; },
    render<T>(fn: () => T): T {
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
  useEffect: rt.useEffect,
}));

type ChangedHandler = (payload: { key: string }) => void;
const invoke = vi.fn<(channel: string, req: unknown) => Promise<unknown>>();
const listeners: ChangedHandler[] = [];
const offs: ReturnType<typeof vi.fn>[] = [];

vi.mock('@renderer/api', () => ({
  api: {
    platform: 'darwin',
    invoke: (...args: [string, unknown]) => invoke(...args),
    on: vi.fn((_channel: string, cb: ChangedHandler) => {
      listeners.push(cb);
      const off = vi.fn();
      offs.push(off);
      return off;
    }),
  },
}));

const { useFrostTerminalAttribute } = await import('@renderer/hooks/useFrostTerminalAttribute');
const { api } = await import('@renderer/api');

function fakeTarget(): RootFlagTarget & { set: Record<string, string>; removed: string[] } {
  const set: Record<string, string> = {};
  const removed: string[] = [];
  return {
    set,
    removed,
    setAttribute(name: string, value: string): void { set[name] = value; },
    removeAttribute(name: string): void { removed.push(name); Reflect.deleteProperty(set, name); },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  rt.reset();
  listeners.length = 0;
  offs.length = 0;
  invoke.mockReset();
  vi.mocked(api.on).mockClear();
});

afterEach(() => {
  rt.unmount();
});

describe('useFrostTerminalAttribute', () => {
  it('re-reads frost_terminal on mount and applies it to the target', async () => {
    invoke.mockResolvedValueOnce({ value: true });
    const target = fakeTarget();
    rt.render(() => useFrostTerminalAttribute(target));
    await flush();
    expect(invoke).toHaveBeenCalledWith('settings:get', { key: 'frost_terminal' });
    expect(target.set[FROST_ATTR.frostTerminal]).toBe('');
    expect(target.set[FROST_ATTR.platform]).toBe(MAC_PLATFORM);
  });

  it('re-reads and re-applies on settings:changed for frost_terminal', async () => {
    invoke.mockResolvedValueOnce({ value: false }).mockResolvedValueOnce({ value: true });
    const target = fakeTarget();
    rt.render(() => useFrostTerminalAttribute(target));
    await flush();
    expect(target.removed).toContain(FROST_ATTR.frostTerminal);

    listeners[0]?.({ key: 'frost_terminal' });
    await flush();
    expect(target.set[FROST_ATTR.frostTerminal]).toBe('');
  });

  it('ignores settings:changed for a different key', async () => {
    invoke.mockResolvedValueOnce({ value: false });
    const target = fakeTarget();
    rt.render(() => useFrostTerminalAttribute(target));
    await flush();
    invoke.mockClear();

    listeners[0]?.({ key: 'window_opacity' });
    await flush();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('cleans up its settings:changed subscription on unmount', async () => {
    invoke.mockResolvedValueOnce({ value: false });
    const target = fakeTarget();
    rt.render(() => useFrostTerminalAttribute(target));
    await flush();
    rt.unmount();
    expect(offs[0]).toHaveBeenCalled();
  });
});
