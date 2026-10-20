/** Fleet activity tests cover discovery, pairing, revocation and safe failures without remote workspaces. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import type { FleetState } from '@shared/fleet-contract';

const runtime = vi.hoisted(() => {
  const slots: unknown[] = [];
  const effects: Array<{ deps?: readonly unknown[]; cleanup?: () => void; run?: () => unknown }> = [];
  let cursor = 0;
  let effectCursor = 0;
  const changed = (a?: readonly unknown[], b?: readonly unknown[]) => !a || !b || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));
  return {
    reset() { slots.length = 0; effects.length = 0; },
    render<T>(fn: () => T): T {
      cursor = 0;
      effectCursor = 0;
      const tree = fn();
      const due = effects.filter((effect) => effect.run);
      for (const effect of due) effect.cleanup?.();
      for (const effect of due) {
        const cleanup = effect.run?.();
        effect.run = undefined;
        effect.cleanup = typeof cleanup === 'function' ? () => { cleanup(); } : undefined;
      }
      return tree;
    },
    unmount() { for (const effect of effects) effect.cleanup?.(); },
    useState<S>(initial: S | (() => S)) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? (initial as () => S)() : initial;
      const set = (next: S | ((value: S) => S)) => { slots[index] = typeof next === 'function' ? (next as (value: S) => S)(slots[index] as S) : next; };
      return [slots[index] as S, set] as const;
    },
    useRef<R>(initial: R) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] as { current: R }; },
    useCallback<F>(fn: F, deps: readonly unknown[]): F {
      const index = cursor++;
      const previous = slots[index] as { fn: F; deps: readonly unknown[] } | undefined;
      if (previous && !changed(previous.deps, deps)) return previous.fn;
      slots[index] = { fn, deps };
      return fn;
    },
    useEffect(run: () => unknown, deps?: readonly unknown[]) {
      const index = effectCursor++;
      const previous = effects[index];
      if (previous && !changed(previous.deps, deps)) return;
      effects[index] = { deps, cleanup: previous?.cleanup, run };
    },
  };
});
vi.mock('react', async (original) => ({ ...(await original<typeof ReactModule>()), useState: runtime.useState, useRef: runtime.useRef, useCallback: runtime.useCallback, useEffect: runtime.useEffect }));
const invoke = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Set<(state: FleetState) => void>());
vi.mock('@renderer/api', () => ({ api: { invoke, on: vi.fn((_channel: string, listener: (state: FleetState) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }) } }));
const { FleetPanel } = await import('@renderer/components/FleetPanel');
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const state = (status: FleetState['peers'][number]['status'], code?: string): FleetState => ({ enabled: true, peers: [{ id: 'machine-b', name: 'Build Mac', status, ...(code ? { verificationCode: code } : {}) }] });

function nodes(node: ReactNode): ReactElement[] {
  if (!isValidElement(node)) return [];
  if (typeof node.type === 'function') {
    const result: unknown = Reflect.apply(node.type, undefined, [node.props]);
    return isValidElement(result) ? nodes(result) : [];
  }
  const children = (node.props as { children?: ReactNode }).children;
  return [node, ...(Array.isArray(children) ? children.flatMap(nodes) : nodes(children))];
}
function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (!isValidElement(node)) return '';
  if (typeof node.type === 'function') {
    const result: unknown = Reflect.apply(node.type, undefined, [node.props]);
    return isValidElement(result) ? text(result) : '';
  }
  return text((node.props as { children?: ReactNode }).children);
}
function mount(initial: FleetState, fail = false) {
  const onOpenSettings = vi.fn();
  invoke.mockImplementation((channel: string) => channel === 'fleet:get-state' ? fail ? Promise.reject(new Error('private diagnostics')) : Promise.resolve(initial) : Promise.resolve({ ok: true }));
  const draw = () => runtime.render(() => FleetPanel({ onOpenSettings }));
  draw();
  return {
    draw,
    onOpenSettings,
    async loaded() { await flush(); draw(); },
    visible() { return text(draw()); },
    control(label: string) {
      const node = nodes(draw()).find((item) => {
        const props = item.props as { children?: ReactNode; 'aria-label'?: string };
        return item.type === 'button' && (props['aria-label'] === label || text(props.children) === label);
      });
      if (!node) throw new Error(`Missing button ${label}`);
      return node.props as { disabled?: boolean; onClick: () => void };
    },
    field() {
      const node = nodes(draw()).find((item) => item.type === 'input' && item.props.type === 'text');
      if (!node) throw new Error('Missing pairing input');
      return node.props as { onChange: (event: { target: { value: string } }) => void };
    },
    switch() {
      const node = nodes(draw()).find((item) => item.type === 'input' && item.props.role === 'switch');
      if (!node) return undefined;
      return node.props as { checked: boolean; onChange: (event: { target: { checked: boolean } }) => void };
    },
    emit(next: FleetState) { for (const listener of listeners) listener(next); },
  };
}
beforeEach(() => { runtime.reset(); listeners.clear(); invoke.mockReset(); });
afterEach(() => { runtime.unmount(); });

describe('FleetPanel discovery and trust', () => {
  it('does not enable discovery when the Fleet settings modal opens', async () => {
    const app = mount({ enabled: false, peers: [] });
    await app.loaded();
    app.control('Open Fleet settings').onClick();
    expect(app.onOpenSettings).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalledWith('fleet:set-enabled', expect.anything());
  });

  it('enables and disables discovery from Fleet while keeping the switch in sync', async () => {
    const app = mount({ enabled: false, peers: [] });
    await app.loaded();
    expect(app.switch()?.checked).toBe(false);
    invoke.mockImplementation((channel: string, args?: { enabled: boolean }) =>
      channel === 'fleet:set-enabled' ? Promise.resolve({ enabled: args?.enabled, peers: [] }) : Promise.resolve({ enabled: false, peers: [] }));
    app.switch()?.onChange({ target: { checked: true } });
    await flush();
    expect(invoke).toHaveBeenCalledWith('fleet:set-enabled', { enabled: true });
    expect(app.switch()?.checked).toBe(true);
    app.switch()?.onChange({ target: { checked: false } });
    await flush();
    expect(invoke).toHaveBeenCalledWith('fleet:set-enabled', { enabled: false });
    expect(app.switch()?.checked).toBe(false);
  });

  it('keeps discovery off after a failed toggle and exposes only a safe retryable error', async () => {
    const app = mount({ enabled: false, peers: [] });
    await app.loaded();
    invoke.mockImplementation((channel: string) => channel === 'fleet:set-enabled'
      ? Promise.reject(new Error('private keychain path')) : Promise.resolve({ enabled: false, peers: [] }));
    app.switch()?.onChange({ target: { checked: true } });
    await flush();
    expect(app.switch()?.checked).toBe(false);
    expect(app.visible()).not.toContain('private keychain path');
    expect(nodes(app.draw()).some((node) => node.props.role === 'alert')).toBe(true);
  });

  it('keeps discovered peers out of project and terminal APIs', async () => {
    const app = mount(state('discovered'));
    await app.loaded();
    expect(app.visible()).toContain('Build Mac');
    app.control('Request link').onClick();
    await flush();
    expect(invoke).toHaveBeenCalledWith('fleet:pair', { peerId: 'machine-b' });
    expect(invoke).not.toHaveBeenCalledWith('fleet:status', expect.anything());
  });

  it('requires matching verification code and clears it on offline transition', async () => {
    const app = mount(state('pending', '123 456'));
    await app.loaded();
    expect(app.control('Approve link').disabled).toBe(true);
    app.field().onChange({ target: { value: 'wrong' } });
    expect(app.control('Approve link').disabled).toBe(true);
    app.field().onChange({ target: { value: '123 456' } });
    app.control('Approve link').onClick();
    await flush();
    expect(invoke).toHaveBeenCalledWith('fleet:approve', { peerId: 'machine-b', verificationCode: '123 456' });
    app.emit(state('offline'));
    expect(app.visible()).not.toContain('123 456');
    app.control('Revoke link').onClick();
    expect(invoke).toHaveBeenCalledWith('fleet:revoke', { peerId: 'machine-b' });
  });

  it('keeps linked peer management separate from remote terminal APIs', async () => {
    const app = mount(state('linked'));
    await app.loaded();
    expect(app.visible()).toContain('Build Mac');
    expect(invoke).not.toHaveBeenCalledWith('fleet:status', expect.anything());
    expect(invoke).not.toHaveBeenCalledWith('fleet:snapshot', expect.anything());
  });

  it('makes failed initial load retryable without exposing private exception text', async () => {
    const app = mount({ enabled: true, peers: [] }, true);
    await app.loaded();
    expect(app.visible()).not.toContain('private diagnostics');
    app.control('Retry').onClick();
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
