/** Remote terminal tests exercise launch, ordered attachment, input, cleanup and stale events. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import type { FleetTerminalEvent } from '@shared/fleet-contract';
import type { RemoteProjectSelection } from '@renderer/components/Sidebar';
import type { TerminalKeyEvent, TerminalKeyHandler } from '@renderer/shortcut-contract';

const runtime = vi.hoisted(() => {
  const slots: unknown[] = [];
  const effects: Array<{ deps?: readonly unknown[]; cleanup?: () => void; run?: () => unknown }> = [];
  let cursor = 0;
  let effectCursor = 0;
  const changed = (a?: readonly unknown[], b?: readonly unknown[]) => !a || !b || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));
  return {
    reset() { slots.length = 0; effects.length = 0; },
    render<T>(fn: () => T, attach: (tree: T) => void): T {
      cursor = 0;
      effectCursor = 0;
      const tree = fn();
      attach(tree);
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
const terminal = vi.hoisted(() => ({ instances: [] as Array<{ writes: string[]; data: (value: string) => void; focus: () => void; paste: (value: string) => void; keyHandler: TerminalKeyHandler | null; disposed: boolean }> }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    cols = 80;
    rows = 24;
    unicode = { activeVersion: '' };
    writes: string[] = [];
    data: (value: string) => void = () => undefined;
    keyHandler: TerminalKeyHandler | null = null;
    focus = vi.fn();
    paste = vi.fn((value: string) => this.data(value));
    disposed = false;
    constructor() { terminal.instances.push(this); }
    loadAddon() {}
    open() {}
    write(value: string) { this.writes.push(value); }
    hasSelection() { return false; }
    getSelection() { return ''; }
    attachCustomKeyEventHandler(handler: TerminalKeyHandler) { this.keyHandler = handler; }
    onData(callback: (data: string) => void) { this.data = callback; return { dispose: () => undefined }; }
    dispose() { this.disposed = true; }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class { activate() { return undefined; } } }));
vi.mock('@renderer/fonts/font-settings-context', () => ({ useFontSettings: () => ({ terminalFontFamily: null }) }));
vi.mock('@renderer/fonts/terminal-font-size-context', () => ({ useTerminalFontSize: () => ({ size: 13 }) }));
vi.mock('@renderer/fonts/terminal-font-weight-context', () => ({ useTerminalFontWeight: () => ({ weight: 400, boldWeight: 700 }) }));
vi.mock('@renderer/shortcut-platform', () => ({ useShortcutPlatform: () => 'other' }));
const invoke = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Set<(event: FleetTerminalEvent) => void>());
vi.mock('@renderer/api', () => ({ api: { invoke, on: vi.fn((_channel: string, listener: (event: FleetTerminalEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }) } }));
const { RemoteTerminal } = await import('@renderer/components/RemoteTerminal');
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const project: RemoteProjectSelection = { peerId: 'machine-b', peerName: 'Build Mac', projectId: 12, projectName: 'Service' };
const event = (kind: FleetTerminalEvent['kind'], data: string, subscriptionId = 'sub-1'): FleetTerminalEvent => ({ peerId: 'machine-b', projectId: 12, shellIndex: 2, subscriptionId, kind, data });
function nodes(node: ReactNode): ReactElement[] {
  if (!isValidElement(node)) return [];
  const children = (node.props as { children?: ReactNode }).children;
  return [node, ...(Array.isArray(children) ? children.flatMap(nodes) : nodes(children))];
}
function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (!isValidElement(node)) return '';
  return text((node.props as { children?: ReactNode }).children);
}
function mount() {
  let available = true;
  const host = { clientWidth: 500, clientHeight: 300 };
  const refresh = vi.fn();
  const draw = () => runtime.render(() => RemoteTerminal({ project, available, onRefreshAvailability: refresh }), (tree) => {
    const region = nodes(tree).find((node) => node.type === 'div' && (node.props as { role?: string }).role === 'region');
    if (region && 'ref' in region) {
      const ref: unknown = region.ref;
      if (ref && typeof ref === 'object' && 'current' in ref) Reflect.set(ref, 'current', host);
    }
  });
  draw();
  return {
    draw,
    refresh,
    visible: () => text(draw()),
    control(label: string) {
      const node = nodes(draw()).find((item) => item.type === 'button' && text((item.props as { children?: ReactNode }).children) === label);
      if (!node) throw new Error(`Missing button ${label}`);
      return node.props as { disabled?: boolean; onClick: () => void };
    },
    offline() { available = false; return draw(); },
    online() { available = true; return draw(); },
    emit(next: FleetTerminalEvent) { for (const listener of listeners) listener(next); },
  };
}
beforeEach(() => {
  runtime.reset();
  terminal.instances.length = 0;
  listeners.clear();
  invoke.mockReset();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  vi.stubGlobal('document', { documentElement: {} });
  invoke.mockImplementation((channel: string) => channel === 'fleet:launch-claude' ? Promise.resolve({ shellIndex: 2 }) : channel === 'fleet:subscribe' ? Promise.resolve({ subscriptionId: 'sub-1' }) : Promise.resolve({ ok: true }));
});
afterEach(() => { runtime.unmount(); vi.unstubAllGlobals(); });

describe('RemoteTerminal', () => {
  it('launches remote Claude, attaches once, writes ANSI snapshot before live output, and sends interactive data', async () => {
    const app = mount();
    expect(invoke).toHaveBeenCalledWith('fleet:launch-claude', { peerId: 'machine-b', projectId: 12 });
    await flush();
    app.draw();
    await flush();
    app.emit(event('snapshot', '\u001b[32mWelcome'));
    app.emit(event('ready', ''));
    app.emit(event('data', ' next'));
    app.draw();
    const instance = terminal.instances[0];
    expect(instance?.writes).toEqual(['\u001b[32mWelcome', ' next']);
    expect(app.visible()).not.toContain('Attaching terminal');
    instance?.data('pwd\r');
    await flush();
    expect(invoke).toHaveBeenCalledWith('fleet:write', { peerId: 'machine-b', projectId: 12, shellIndex: 2, data: 'pwd\r' });
    expect(invoke).toHaveBeenCalledWith('fleet:resize', { peerId: 'machine-b', projectId: 12, shellIndex: 2, cols: 80, rows: 24 });
  });

  it('buffers early events until subscribe resolves and discards other subscription IDs', async () => {
    let resolve: (value: { subscriptionId: string }) => void = () => undefined;
    invoke.mockImplementation((channel: string) => channel === 'fleet:subscribe' ? new Promise<{ subscriptionId: string }>((done) => { resolve = done; }) : channel === 'fleet:launch-claude' ? Promise.resolve({ shellIndex: 2 }) : Promise.resolve({ ok: true }));
    const app = mount();
    await flush();
    app.draw();
    app.emit(event('snapshot', 'stale', 'old-subscription'));
    app.emit(event('snapshot', 'one'));
    app.emit(event('ready', ''));
    app.emit(event('data', 'two'));
    expect(terminal.instances[0]?.writes).toEqual([]);
    resolve({ subscriptionId: 'sub-1' });
    await flush();
    expect(terminal.instances[0]?.writes).toEqual(['one', 'two']);
    expect(app.control('Paste').disabled).toBe(false);
  });

  it('unsubscribes and disables input on offline/revoke, and ignores late events', async () => {
    const app = mount();
    await flush();
    app.draw();
    await flush();
    app.emit(event('ready', ''));
    const instance = terminal.instances[0];
    app.offline();
    expect(app.visible()).toContain('offline or unlinked');
    app.control('Refresh connection').onClick();
    expect(app.refresh).toHaveBeenCalledOnce();
    expect(instance?.disposed).toBe(true);
    expect(invoke).toHaveBeenCalledWith('fleet:unsubscribe', { peerId: 'machine-b', subscriptionId: 'sub-1' });
    app.emit(event('data', 'must not render'));
    instance?.data('must not write');
    expect(instance?.writes).not.toContain('must not render');
    expect(invoke).not.toHaveBeenCalledWith('fleet:write', expect.objectContaining({ data: 'must not write' }));
  });

  it('rejects stale launch responses after disconnect and never subscribes', async () => {
    let finishLaunch: (value: { shellIndex: number }) => void = () => undefined;
    invoke.mockImplementation((channel: string) => channel === 'fleet:launch-claude'
      ? new Promise<{ shellIndex: number }>((resolve) => { finishLaunch = resolve; })
      : Promise.resolve({ ok: true }));
    const app = mount();
    app.offline();
    finishLaunch({ shellIndex: 2 });
    await flush();
    app.draw();
    expect(invoke).not.toHaveBeenCalledWith('fleet:subscribe', expect.anything());
    expect(app.visible()).toContain('offline or unlinked');
  });

  it('unsubscribes a late subscribe response after leaving the remote machine', async () => {
    let finishSubscribe: (value: { subscriptionId: string }) => void = () => undefined;
    invoke.mockImplementation((channel: string) => channel === 'fleet:launch-claude'
      ? Promise.resolve({ shellIndex: 2 })
      : channel === 'fleet:subscribe'
        ? new Promise<{ subscriptionId: string }>((resolve) => { finishSubscribe = resolve; })
        : Promise.resolve({ ok: true }));
    const app = mount();
    await flush();
    app.draw();
    app.emit(event('snapshot', 'private output'));
    app.offline();
    finishSubscribe({ subscriptionId: 'sub-1' });
    await flush();
    expect(invoke).toHaveBeenCalledWith('fleet:unsubscribe', { peerId: 'machine-b', subscriptionId: 'sub-1' });
    expect(terminal.instances[0]?.writes).toEqual([]);
  });

  it('announces process exit and ignores subsequent output or keystrokes', async () => {
    const app = mount();
    await flush();
    app.draw();
    await flush();
    app.emit(event('ready', ''));
    app.emit(event('exit', '0'));
    app.emit(event('data', 'late'));
    terminal.instances[0]?.data('ignored');
    expect(app.control('Paste').disabled).toBe(true);
    expect(terminal.instances[0]?.writes).not.toContain('late');
    expect(invoke).not.toHaveBeenCalledWith('fleet:write', expect.objectContaining({ data: 'ignored' }));
  });

  it('reattaches Claude on reconnect rather than creating a local shell', async () => {
    const app = mount();
    await flush();
    app.draw();
    await flush();
    app.offline();
    app.online();
    await flush();
    app.draw();
    expect(invoke.mock.calls.filter(([channel]) => channel === 'fleet:launch-claude')).toHaveLength(2);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'fleet:subscribe')).toHaveLength(2);
    expect(invoke).not.toHaveBeenCalledWith('shells:launch', expect.anything());
  });

  it('replaces the subscription when retry reattaches the same Claude shell index', async () => {
    const app = mount();
    await flush();
    app.draw();
    await flush();
    const first = terminal.instances[0];
    app.control('Retry Claude').onClick();
    await flush();
    app.draw();
    expect(first?.disposed).toBe(true);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'fleet:subscribe')).toHaveLength(2);
    expect(invoke).toHaveBeenCalledWith('fleet:unsubscribe', { peerId: 'machine-b', subscriptionId: 'sub-1' });
  });

  it('preserves a large Unicode paste and ANSI escapes as ordered <=4096-byte writes with one request in flight', async () => {
    const resolvers: Array<() => void> = [];
    let inFlight = 0;
    let maximum = 0;
    invoke.mockImplementation((channel: string) => {
      if (channel === 'fleet:launch-claude') return Promise.resolve({ shellIndex: 2 });
      if (channel === 'fleet:subscribe') return Promise.resolve({ subscriptionId: 'sub-1' });
      if (channel !== 'fleet:write') return Promise.resolve({ ok: true });
      inFlight++;
      maximum = Math.max(maximum, inFlight);
      return new Promise<{ ok: true }>((resolve) => {
        resolvers.push(() => { inFlight--; resolve({ ok: true }); });
      });
    });
    const app = mount();
    await flush();
    app.draw();
    await flush();
    app.emit(event('ready', ''));
    const payload = `\u001b[31m${'🌍'.repeat(2400)}\u001b[0m`;
    terminal.instances[0]?.paste(payload);
    await flush();
    expect(invoke.mock.calls.filter(([channel]) => channel === 'fleet:write')).toHaveLength(1);
    for (let index = 0; index < 3; index++) {
      await vi.waitFor(() => expect(resolvers[index]).toBeDefined());
      resolvers[index]!();
    }
    const chunks = invoke.mock.calls.filter(([channel]) => channel === 'fleet:write').map(([, request]) => request.data as string);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.join('')).toBe(payload);
    expect(chunks.every((chunk) => new TextEncoder().encode(chunk).length <= 4096)).toBe(true);
    expect(maximum).toBe(1);
  });

  it('offers retry on launch failure, plain shell separately, and stop on a running session', async () => {
    invoke.mockImplementation((channel: string) => channel === 'fleet:launch-claude' ? Promise.reject(new Error('private launch command')) : channel === 'fleet:launch' ? Promise.resolve({ shellIndex: 2 }) : channel === 'fleet:subscribe' ? Promise.resolve({ subscriptionId: 'sub-1' }) : Promise.resolve({ ok: true }));
    const app = mount();
    await flush();
    expect(app.visible()).toContain('Could not open Claude');
    expect(app.visible()).not.toContain('private launch command');
    app.control('New plain shell').onClick();
    await flush();
    app.draw();
    await flush();
    app.emit(event('ready', ''));
    app.draw();
    expect(invoke).toHaveBeenCalledWith('fleet:launch', { peerId: 'machine-b', projectId: 12 });
    app.control('Stop remote shell').onClick();
    expect(invoke).toHaveBeenCalledWith('fleet:stop', { peerId: 'machine-b', projectId: 12, shellIndex: 2 });
  });

  it('shows only the remote host’s whitelisted permission guidance', async () => {
    invoke.mockImplementation((channel: string) => channel === 'fleet:launch-claude'
      ? Promise.reject(new Error('Error invoking remote method: Choose a Claude permission mode on the remote machine first'))
      : Promise.resolve({ ok: true }));
    const app = mount();
    await flush();
    expect(app.visible()).toContain('Choose a Claude permission mode on the remote machine first');
    expect(app.visible()).not.toContain('Error invoking remote method');
  });
  it('keeps terminal attachment behind loaded fonts and measured dimensions', async () => {
    let fontsLoaded!: () => void;
    const fontsReady = new Promise<void>((resolve) => { fontsLoaded = resolve; });
    vi.stubGlobal('document', { documentElement: {}, fonts: { ready: fontsReady } });
    const app = mount();
    await flush();
    app.draw();
    expect(invoke).not.toHaveBeenCalledWith('fleet:subscribe', expect.anything());
    fontsLoaded();
    await flush();
    expect(invoke).toHaveBeenCalledWith('fleet:subscribe', { peerId: 'machine-b', projectId: 12, shellIndex: 2 });
  });

  it('routes terminal paste shortcut into the remote PTY without local shell input', async () => {
    const clipboard = { readText: vi.fn(async () => 'remote paste\r'), writeText: vi.fn(async () => undefined) };
    vi.stubGlobal('navigator', { clipboard });
    const app = mount();
    await flush();
    app.draw();
    await flush();
    app.emit(event('ready', ''));
    const key: TerminalKeyEvent = {
      type: 'keydown', key: 'v', ctrlKey: true, shiftKey: true,
      altKey: false, metaKey: false, preventDefault: vi.fn(),
    };
    expect(terminal.instances[0]?.keyHandler?.(key)).toBe(false);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('fleet:write',
      { peerId: 'machine-b', projectId: 12, shellIndex: 2, data: 'remote paste\r' }));
    expect(key.preventDefault).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalledWith('shells:write', expect.anything());
  });
});
