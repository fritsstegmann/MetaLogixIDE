/** Shell control tests cover initial state, live control transitions, isolation and stale state replies. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as ReactModule from 'react';
import type { FleetState } from '@shared/fleet-contract';

const runtime = vi.hoisted(() => {
  const slots: unknown[] = [];
  const effects: Array<{ cleanup?: () => void; deps?: readonly unknown[] }> = [];
  let cursor = 0;
  let effectCursor = 0;
  return {
    reset() { slots.length = 0; effects.length = 0; },
    render<T>(render: () => T): T {
      cursor = 0;
      effectCursor = 0;
      return render();
    },
    useState<S>(initial: S) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index] as S, (next: S) => { slots[index] = next; }] as const;
    },
    useEffect(run: () => (() => void) | undefined, deps: readonly unknown[]) {
      const index = effectCursor++;
      const previous = effects[index];
      if (previous?.deps && previous.deps.length === deps.length && previous.deps.every((value, i) => Object.is(value, deps[i]))) return;
      previous?.cleanup?.();
      const cleanup = run();
      effects[index] = { deps, ...(typeof cleanup === 'function' ? { cleanup } : {}) };
    },
    unmount() { for (const effect of effects) effect.cleanup?.(); },
  };
});
vi.mock('react', async (original) => ({ ...(await original<typeof ReactModule>()), useState: runtime.useState, useEffect: runtime.useEffect }));
const invoke = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Set<(state: FleetState) => void>());
vi.mock('@renderer/api', () => ({ api: { invoke, on: vi.fn((_channel: string, listener: (state: FleetState) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }) } }));
vi.stubGlobal('self', globalThis);
const { ShellTab } = await import('@renderer/components/ShellTab');
const empty = { enabled: true, peers: [], port: 43872, controls: [] } satisfies FleetState;
const controlled = { ...empty, controls: [{ projectId: 5, shellIndex: 2, peerName: 'Build Mac' }] } satisfies FleetState;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function draw(projectId = 5, shellIndex = 2): ReactElement {
  return runtime.render(() => ShellTab({ projectId, shellIndex, primary: true, popout: true }));
}
function emit(state: FleetState) { for (const listener of listeners) listener(state); }
function localShell(node: ReactElement) { return typeof node.type === 'function' && node.type !== ShellTab; }

beforeEach(() => { runtime.reset(); listeners.clear(); invoke.mockReset(); });
afterEach(() => runtime.unmount());

describe('ShellTab remote control', () => {
  it('does not mount interactive terminal until initial state resolves, then restores local shell', async () => {
    let resolve: (state: FleetState) => void = () => undefined;
    invoke.mockImplementation(() => new Promise<FleetState>((done) => { resolve = done; }));
    expect(localShell(draw())).toBe(false);
    expect(renderToStaticMarkup(draw())).toContain('Checking terminal control');
    resolve(empty);
    await flush();
    expect(localShell(draw())).toBe(true);
    expect(invoke).toHaveBeenCalledWith('fleet:get-state', undefined);
  });

  it('announces exact controller and hides only its targeted shell, then remounts terminal on detach', async () => {
    invoke.mockResolvedValue(empty);
    draw();
    await flush();
    expect(localShell(draw())).toBe(true);
    emit(controlled);
    const notice = draw();
    expect(localShell(notice)).toBe(false);
    const markup = renderToStaticMarkup(notice);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('Build Mac');
    expect(markup).toContain('controlled remotely');
    expect(localShell(draw(5, 1))).toBe(true);
    expect(localShell(draw(6, 2))).toBe(true);
    emit(empty);
    expect(localShell(draw())).toBe(true);
    expect(listeners.size).toBe(1);
  });

  it('keeps the newest live control event over stale initial state and cleans up listeners', async () => {
    let resolve: (state: FleetState) => void = () => undefined;
    invoke.mockImplementation(() => new Promise<FleetState>((done) => { resolve = done; }));
    draw();
    emit(controlled);
    resolve(empty);
    await flush();
    expect(renderToStaticMarkup(draw())).toContain('Build Mac');
    runtime.unmount();
    expect(listeners.size).toBe(0);
    emit(empty);
    expect(renderToStaticMarkup(draw())).toContain('Build Mac');
  });

  it('does not start interactive shell when initial Fleet state fails; live update restores it', async () => {
    invoke.mockRejectedValue(new Error('private details'));
    draw();
    await flush();
    expect(localShell(draw())).toBe(false);
    const markup = renderToStaticMarkup(draw());
    expect(markup).toContain('role="alert"');
    expect(markup).not.toContain('private details');
    emit(empty);
    expect(localShell(draw())).toBe(true);
  });
});
