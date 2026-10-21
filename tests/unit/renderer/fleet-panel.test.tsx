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
const state = (status: FleetState['peers'][number]['status'], code?: string): FleetState => ({ enabled: true, port: 43872, controls: [], peers: [{ id: 'machine-b', name: 'Build Mac', status, ...(code ? { verificationCode: code } : {}) }] });

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
  invoke.mockImplementation((channel: string) => channel === 'fleet:get-state' ? fail ? Promise.reject(new Error('private diagnostics')) : Promise.resolve(initial) : Promise.resolve({ ok: true }));
  const draw = () => runtime.render(() => FleetPanel());
  draw();
  return {
    draw,
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
    portField() {
      const node = nodes(draw()).find((item) => item.type === 'input' && item.props['aria-label'] === 'Fleet port');
      if (!node) throw new Error('Missing port input');
      return node.props as { value: string; onChange: (event: { target: { value: string } }) => void };
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
  it('enables and disables discovery from Fleet while keeping the switch in sync', async () => {
    const app = mount({ enabled: false, peers: [], port: 43872, controls: [] });
    await app.loaded();
    expect(app.switch()?.checked).toBe(false);
    invoke.mockImplementation((channel: string, args?: { enabled: boolean }) =>
      channel === 'fleet:set-enabled' ? Promise.resolve({ enabled: args?.enabled, peers: [], port: 43872, controls: [] }) : Promise.resolve({ enabled: false, peers: [], port: 43872, controls: [] }));
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
    const app = mount({ enabled: false, peers: [], port: 43872, controls: [] });
    await app.loaded();
    invoke.mockImplementation((channel: string) => channel === 'fleet:set-enabled'
      ? Promise.reject(new Error('private keychain path')) : Promise.resolve({ enabled: false, peers: [], port: 43872, controls: [] }));
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
    const app = mount({ enabled: true, peers: [], port: 43872, controls: [] }, true);
    await app.loaded();
    expect(app.visible()).not.toContain('private diagnostics');
    app.control('Retry').onClick();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  describe('port and identity recovery', () => {
    const idle: FleetState = { enabled: false, peers: [], port: 43872, controls: [] };
    function intercept(handler: (channel: string, request: unknown) => unknown) {
      const base = invoke.getMockImplementation();
      invoke.mockImplementation((channel: string, request: unknown) => {
        const result = handler(channel, request);
        return result === undefined ? base?.(channel, request) : result;
      });
    }

    it('shows the specific listener error instead of the generic failure when enabling fails', async () => {
      const app = mount(idle);
      await app.loaded();
      intercept((channel) => {
        if (channel === 'fleet:set-enabled') return Promise.reject(new Error('internal keychain diagnostics'));
        if (channel === 'fleet:get-state') return Promise.resolve({ ...idle, error: 'Fleet port 43872 is already in use' });
        return undefined;
      });
      app.switch()?.onChange({ target: { checked: true } });
      await flush();
      await flush();
      const visible = app.visible();
      expect(visible).toContain('Fleet port 43872 is already in use');
      expect(visible).not.toContain('Could not change Fleet discovery');
      expect(visible).not.toContain('keychain diagnostics');
    });

    it('shows the current port with the firewall rules for that port', async () => {
      const app = mount({ ...idle, port: 45123 });
      await app.loaded();
      const visible = app.visible();
      expect(visible).toContain('sudo ufw allow 43871/udp');
      expect(visible).toContain('sudo ufw allow 45123/tcp');
      expect(visible).not.toContain('43872/tcp');
      expect(app.portField().value).toBe('45123');
    });

    it('saves the typed port through fleet:set-port and shows the returned port', async () => {
      const app = mount(idle);
      await app.loaded();
      intercept((channel, request) =>
        channel === 'fleet:set-port' ? Promise.resolve({ ...idle, port: (request as { port: number }).port }) : undefined,
      );
      app.portField().onChange({ target: { value: '45000' } });
      app.control('Save port').onClick();
      await flush();
      expect(invoke).toHaveBeenCalledWith('fleet:set-port', { port: 45000 });
      expect(app.visible()).toContain('sudo ufw allow 45000/tcp');
    });

    it('shows the main-side rejection message and keeps the old port', async () => {
      const app = mount(idle);
      await app.loaded();
      intercept((channel) =>
        channel === 'fleet:set-port'
          ? Promise.reject(new Error("Error invoking remote method 'fleet:set-port': Error: Fleet port 1000 is already in use"))
          : undefined,
      );
      app.portField().onChange({ target: { value: '1000' } });
      app.control('Save port').onClick();
      await flush();
      expect(app.visible()).toContain('Fleet port 1000 is already in use');
      expect(app.visible()).not.toContain('Error invoking remote method');
      expect(app.visible()).toContain('sudo ufw allow 43872/tcp');
    });

    it('disables Save while the port field is empty or unchanged', async () => {
      const app = mount(idle);
      await app.loaded();
      expect(app.control('Save port').disabled).toBe(true);
      app.portField().onChange({ target: { value: '' } });
      expect(app.control('Save port').disabled).toBe(true);
      app.portField().onChange({ target: { value: '43873' } });
      expect(app.control('Save port').disabled).toBe(false);
    });

    it('offers Reset identity only in the recovery state', async () => {
      const healthy = mount(idle);
      await healthy.loaded();
      expect(healthy.visible()).not.toContain('Reset identity');
      runtime.unmount();
      runtime.reset();
      const stuck = mount({ ...idle, recovery: 'reset-identity', error: 'Fleet identity in the credential store is unreadable.' });
      await stuck.loaded();
      expect(stuck.visible()).toContain('unreadable');
      expect(stuck.visible()).toContain('Reset identity');
    });

    it('arms on first click and only resets on the second', async () => {
      const app = mount({ ...idle, recovery: 'reset-identity' });
      await app.loaded();
      intercept((channel) => (channel === 'fleet:reset-identity' ? Promise.resolve(idle) : undefined));
      app.control('Reset identity').onClick();
      await flush();
      expect(invoke).not.toHaveBeenCalledWith('fleet:reset-identity', undefined);
      expect(app.visible()).toContain('Confirm reset — paired devices must pair again');
      app.control('Confirm reset — paired devices must pair again').onClick();
      await flush();
      expect(invoke).toHaveBeenCalledWith('fleet:reset-identity', undefined);
      expect(app.visible()).not.toContain('Reset identity');
      expect(app.visible()).not.toContain('Confirm reset');
    });

    it('disarms when recovery ends elsewhere so a stale confirm cannot fire later', async () => {
      const app = mount({ ...idle, recovery: 'reset-identity' });
      await app.loaded();
      app.control('Reset identity').onClick();
      await flush();
      app.emit(idle);
      app.emit({ ...idle, recovery: 'reset-identity' });
      expect(app.visible()).toContain('Reset identity');
      expect(app.visible()).not.toContain('Confirm reset');
    });
  });
});
