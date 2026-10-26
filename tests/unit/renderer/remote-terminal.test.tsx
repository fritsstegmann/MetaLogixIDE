/** Remote terminal tests cover ordered asynchronous replay, viewport intent, split attachment, input, and teardown. */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as ReactModule from 'react';
import type { FleetShell, FleetTerminalEvent } from '@shared/fleet-contract';
import type { RemoteProjectSelection } from '@renderer/components/Sidebar';
import type { TerminalKeyEvent, TerminalKeyHandler } from '@renderer/shortcut-contract';

const runtime = vi.hoisted(() => {
  type Effect = { deps?: readonly unknown[]; cleanup?: () => void; run?: () => unknown };
  type Scope = { slots: unknown[]; effects: Effect[]; cursor: number; effectCursor: number };
  const fresh = (): Scope => ({ slots: [], effects: [], cursor: 0, effectCursor: 0 });
  let root = fresh();
  const children = new Map<string, Scope>();
  let visited = new Set<string>();
  let scope = root;
  const changed = (a?: readonly unknown[], b?: readonly unknown[]) => !a || !b || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));
  const unmountScope = (target: Scope) => { for (const effect of target.effects) effect.cleanup?.(); };
  return {
    reset() { root = fresh(); scope = root; children.clear(); },
    /** Renders a keyed child component in its own hook scope, so it mounts, updates and unmounts like a React child. */
    child<T>(key: string, fn: () => T): T {
      const parent = scope;
      const target = children.get(key) ?? fresh();
      children.set(key, target);
      visited.add(key);
      target.cursor = 0;
      target.effectCursor = 0;
      scope = target;
      try { return fn(); } finally { scope = parent; }
    },
    render<T>(fn: () => T, attach: (tree: T) => void): T {
      root.cursor = 0;
      root.effectCursor = 0;
      visited = new Set();
      scope = root;
      const tree = fn();
      attach(tree);
      for (const [key, target] of [...children]) if (!visited.has(key)) { unmountScope(target); children.delete(key); }
      const due = [...children.values(), root].flatMap((target) => target.effects.filter((effect) => effect.run));
      for (const effect of due) effect.cleanup?.();
      for (const effect of due) {
        const cleanup = effect.run?.();
        effect.run = undefined;
        effect.cleanup = typeof cleanup === 'function' ? () => { cleanup(); } : undefined;
      }
      return tree;
    },
    unmount() { for (const target of children.values()) unmountScope(target); unmountScope(root); },
    useState<S>(initial: S | (() => S)) {
      const { slots } = scope;
      const index = scope.cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? (initial as () => S)() : initial;
      const set = (next: S | ((value: S) => S)) => { slots[index] = typeof next === 'function' ? (next as (value: S) => S)(slots[index] as S) : next; };
      return [slots[index] as S, set] as const;
    },
    useRef<R>(initial: R) { const { slots } = scope; const index = scope.cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] as { current: R }; },
    useCallback<F>(fn: F, deps: readonly unknown[]): F {
      const { slots } = scope;
      const index = scope.cursor++;
      const previous = slots[index] as { fn: F; deps: readonly unknown[] } | undefined;
      if (previous && !changed(previous.deps, deps)) return previous.fn;
      slots[index] = { fn, deps };
      return fn;
    },
    useMemo<F>(fn: () => F, deps: readonly unknown[]): F {
      const { slots } = scope;
      const index = scope.cursor++;
      const previous = slots[index] as { value: F; deps: readonly unknown[] } | undefined;
      if (previous && !changed(previous.deps, deps)) return previous.value;
      const value = fn();
      slots[index] = { value, deps };
      return value;
    },
    useEffect(run: () => unknown, deps?: readonly unknown[]) {
      const { effects } = scope;
      const index = scope.effectCursor++;
      const previous = effects[index];
      if (previous && !changed(previous.deps, deps)) return;
      effects[index] = { deps, cleanup: previous?.cleanup, run };
    },
  };
});
vi.mock('react', async (original) => ({ ...(await original<typeof ReactModule>()), useState: runtime.useState, useRef: runtime.useRef, useCallback: runtime.useCallback, useMemo: runtime.useMemo, useEffect: runtime.useEffect }));
type OscHandler = (data: string) => boolean | Promise<boolean>;
type FakeTerminal = {
  writes: string[];
  parsed: string[];
  callbacks: Array<() => void>;
  data: (value: string) => void;
  focus: Mock;
  paste: (value: string) => void;
  keyHandler: TerminalKeyHandler | null;
  osc: Map<number, OscHandler>;
  oscDisposed: number;
  disposed: boolean;
  cols: number;
  rows: number;
  buffer: { active: { viewportY: number; baseY: number }; alternate: { viewportY: number; baseY: number } };
  scrollToBottom: Mock;
  finishWrite: () => void;
  onScroll: (listener: (viewportY: number) => void) => { dispose: () => void };
  userScroll: (viewportY: number) => void;
};
const terminal = vi.hoisted(() => ({ instances: [] as FakeTerminal[] }));
const viewportGate = vi.hoisted(() => ({
  delayed: false,
  missing: false,
  scrollHeight: 300,
  scrollTop: 0,
  frames: [] as FrameRequestCallback[],
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    cols = 80;
    rows = 24;
    unicode = { activeVersion: '' };
    writes: string[] = [];
    parsed: string[] = [];
    lineCount = 0;
    callbacks: Array<() => void> = [];
    data: (value: string) => void = () => undefined;
    keyHandler: TerminalKeyHandler | null = null;
    osc = new Map<number, OscHandler>();
    oscDisposed = 0;
    parser = { registerOscHandler: (ident: number, handler: OscHandler) => { this.osc.set(ident, handler); return { dispose: () => { this.oscDisposed++; } }; } };
    focus = vi.fn();
    paste = vi.fn((value: string) => this.data(value));
    disposed = false;
    buffer = { normal: { viewportY: 0, baseY: 0 }, alternate: { viewportY: 0, baseY: 0 }, active: { viewportY: 0, baseY: 0 } };
    scrollListeners = new Set<(viewportY: number) => void>();
    scrollToBottom = vi.fn(() => { this.buffer.active.viewportY = this.buffer.active.baseY; });
    constructor() { this.buffer.active = this.buffer.normal; terminal.instances.push(this); }
    loadAddon() {}
    open(host: object) {
      const buffer = this.buffer;
      const viewport = {
        clientHeight: 300,
        get scrollHeight() { return viewportGate.delayed ? viewportGate.scrollHeight : 300 + buffer.active.baseY * 16; },
        get scrollTop() { return viewportGate.delayed ? viewportGate.scrollTop : buffer.active.viewportY * 16; },
      };
      Reflect.set(host, 'querySelector', (selector: string) => selector === '.xterm-viewport' && !viewportGate.missing ? viewport : null);
    }
    write(value: string, callback?: () => void) {
      if (value) this.writes.push(value);
      this.callbacks.push(() => {
        this.parsed.push(value);
        for (const match of value.matchAll(/\u001b]52;([^\u0007]*)\u0007/g))
          void this.osc.get(52)?.(match[1] ?? '');
        if (value.includes('\u001b[?1049h')) this.buffer.active = this.buffer.alternate;
        if (value.includes('\u001b[?1049l')) this.buffer.active = this.buffer.normal;
        if (value.includes('\n') && this.buffer.active === this.buffer.normal) {
          const previousBase = this.buffer.normal.baseY;
          this.lineCount += value.split('\n').length - 1;
          this.buffer.normal.baseY = Math.max(0, this.lineCount - this.rows);
          if (this.buffer.normal.viewportY === previousBase)
            this.buffer.normal.viewportY = this.buffer.normal.baseY;
        }
        callback?.();
      });
    }
    finishWrite() { const callback = this.callbacks.shift(); if (!callback) throw new Error('No queued xterm write'); callback(); }
    userScroll(viewportY: number) {
      this.buffer.active.viewportY = viewportY;
      for (const listener of this.scrollListeners) listener(viewportY);
    }
    onScroll(listener: (viewportY: number) => void) { this.scrollListeners.add(listener); return { dispose: () => { this.scrollListeners.delete(listener); } }; }
    hasSelection() { return false; }
    getSelection() { return ''; }
    attachCustomKeyEventHandler(handler: TerminalKeyHandler) { this.keyHandler = handler; }
    onData(callback: (data: string) => void) { this.data = callback; return { dispose: () => undefined }; }
    dispose() { this.disposed = true; }
  },
}));
const fits = vi.hoisted(() => ({ count: 0, dimensions: { cols: 80, rows: 24 } }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() { fits.count++; const instance = terminal.instances.at(-1); if (instance) { instance.cols = fits.dimensions.cols; instance.rows = fits.dimensions.rows; } } } }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class { activate() { return undefined; } } }));
vi.mock('@renderer/fonts/font-settings-context', () => ({ useFontSettings: () => ({ terminalFontFamily: null }) }));
const font = vi.hoisted(() => ({ size: 13 }));
vi.mock('@renderer/fonts/terminal-font-size-context', () => ({ useTerminalFontSize: () => ({ size: font.size }) }));
vi.mock('@renderer/fonts/terminal-font-weight-context', () => ({ useTerminalFontWeight: () => ({ weight: 400, boldWeight: 700 }) }));
vi.mock('@renderer/shortcut-platform', () => ({ useShortcutPlatform: () => 'other' }));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@renderer/hooks/useToasts', () => ({ toast }));
const invoke = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Set<(event: FleetTerminalEvent) => void>());
const remote = vi.hoisted(() => ({
  shells: [] as FleetShell[],
  status: null as (() => Promise<{ roots: never[]; projects: never[]; shells: FleetShell[] }>) | null,
}));
vi.mock('@renderer/api', () => ({ api: { invoke: (channel: string, ...args: unknown[]) => channel === 'fleet:status'
  ? remote.status?.() ?? Promise.resolve({ roots: [], projects: [], shells: remote.shells })
  : channel === 'fleet:profiles'
    ? Promise.resolve({ profiles: [], defaultCliName: null })
    : invoke(channel, ...args), on: vi.fn((_channel: string, listener: (event: FleetTerminalEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }) } }));
const { RemoteTerminal } = await import('@renderer/components/RemoteTerminal');
const { ShellTabsBar } = await import('@renderer/components/ShellTabsBar');
const { RemoteTerminalPane } = await import('@renderer/components/RemoteTerminalPane');
const { SplitGutter } = await import('@renderer/components/SplitGutter');
const { SplitPaneHeader } = await import('@renderer/components/SplitPaneHeader');
const { SPLIT_RATIO_DEFAULT } = await import('@renderer/split-ratio');
type PaneProps = ReactModule.ComponentProps<typeof RemoteTerminalPane>;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const project: RemoteProjectSelection = { peerId: 'machine-b', peerName: 'Build Mac', projectId: 12, projectName: 'Service' };
const event = (kind: FleetTerminalEvent['kind'], data: string, subscriptionId = 'sub-1'): FleetTerminalEvent => ({ peerId: 'machine-b', projectId: 12, shellIndex: 2, subscriptionId, kind, data });
const shellRow = (shellIndex: number, launchName = 'Terminal'): FleetShell => ({
  projectId: 12, shellIndex, launchName, agent: null, state: 'idle',
  pinned: false, startedAt: null, lastActiveAt: null,
});
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
type ExtraProps = Pick<ReactModule.ComponentProps<typeof RemoteTerminal>, 'focusShell' | 'onShellsChange'>;
function mount(initial: ExtraProps = {}) {
  let available = true;
  let extra = initial;
  const host = { clientWidth: 500, clientHeight: 300 };
  const observers: Array<() => void> = [];
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { observers.push(callback); } observe() {} disconnect() {} });
  const refresh = vi.fn();
  const hosts = [host];
  let panes: ReactElement[] = [];
  const draw = () => runtime.render(() => {
    const tree = RemoteTerminal({ project, available, onRefreshAvailability: refresh, ...extra });
    panes = nodes(tree).filter((node) => node.type === RemoteTerminalPane)
      .map((node) => runtime.child(`pane:${String(node.key)}`, () => RemoteTerminalPane(node.props as PaneProps)));
    return tree;
  }, (tree) => {
    const regions = [tree, ...panes].flatMap(nodes).filter((node) => node.type === 'div' && (node.props as { role?: string }).role === 'region');
    regions.forEach((region, index) => {
      const ref: unknown = 'ref' in region ? region.ref : null;
      hosts[index] ??= { clientWidth: 500, clientHeight: 300 };
      if (ref && typeof ref === 'object' && 'current' in ref) Reflect.set(ref, 'current', hosts[index]);
    });
  });
  draw();
  return {
    draw,
    refresh,
    visible: () => text(draw()),
    bar() {
      const bar = nodes(draw()).find((node) => node.type === ShellTabsBar);
      if (!bar) throw new Error('Missing remote shell tab strip');
      return bar.props as ReactModule.ComponentProps<typeof ShellTabsBar>;
    },
    control(label: string) {
      const node = nodes(draw()).find((item) => item.type === 'button' && (text((item.props as { children?: ReactNode }).children) === label || (item.props as { 'aria-label'?: string })['aria-label'] === label));
      if (!node) throw new Error(`Missing button ${label}`);
      return node.props as { disabled?: boolean; onClick: () => void };
    },
    panes() { draw(); return panes.length; },
    paneShells() { return nodes(draw()).filter((node) => node.type === RemoteTerminalPane).map((node) => (node.props as PaneProps).shellIndex); },
    paneVisibility() {
      draw();
      return panes.map((pane) => {
        const props: unknown = pane.props;
        if (!props || typeof props !== 'object' || !('style' in props)) return undefined;
        const style: unknown = props.style;
        return style && typeof style === 'object' && 'visibility' in style ? style.visibility : undefined;
      });
    },
    find<P>(type: unknown): P[] { return nodes(draw()).filter((node) => node.type === type).map((node) => node.props as P); },
    offline() { available = false; return draw(); },
    props(next: ExtraProps) { extra = { ...extra, ...next }; return draw(); },
    online() { available = true; return draw(); },
    emit(next: FleetTerminalEvent) { for (const listener of listeners) listener(next); },
    resizeHost(cols: number, rows: number) {
      host.clientWidth = cols * 8;
      host.clientHeight = rows * 16;
      fits.dimensions = { cols, rows };
      for (const notify of observers) notify();
    },
  };
}
beforeEach(() => {
  runtime.reset();
  terminal.instances.length = 0;
  fits.count = 0;
  fits.dimensions = { cols: 80, rows: 24 };
  font.size = 13;
  remote.shells = [];
  remote.status = null;
  invoke.mockReset();
  toast.mockReset();
  viewportGate.delayed = false;
  viewportGate.missing = false;
  viewportGate.scrollHeight = 300;
  viewportGate.scrollTop = 0;
  viewportGate.frames.length = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    if (viewportGate.delayed) viewportGate.frames.push(callback);
    else callback(0);
    return viewportGate.frames.length;
  });
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
    await flush();
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
    instance?.finishWrite();
    instance?.finishWrite();
    app.draw();
    expect(app.visible()).not.toContain('Attaching terminal');
    instance?.data('pwd\r');
    await flush();
    expect(invoke).toHaveBeenCalledWith('fleet:write', { peerId: 'machine-b', projectId: 12, shellIndex: 2, data: 'pwd\r' });
    expect(invoke).toHaveBeenCalledWith('fleet:resize', { peerId: 'machine-b', projectId: 12, shellIndex: 2, cols: 80, rows: 24 });
    expect(invoke.mock.invocationCallOrder[invoke.mock.calls.findIndex(([channel]) => channel === 'fleet:subscribe')]).toBeLessThan(
      invoke.mock.invocationCallOrder[invoke.mock.calls.findIndex(([channel]) => channel === 'fleet:resize')] ?? 0,
    );
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
    terminal.instances[0]?.finishWrite();
    terminal.instances[0]?.finishWrite();
    app.draw();
    expect(app.control('Paste').disabled).toBe(false);
    expect(invoke).toHaveBeenCalledWith('fleet:resize', { peerId: 'machine-b', projectId: 12, shellIndex: 2, cols: 80, rows: 24 });
  });

  it('settles a long chunked snapshot at the newest parsed output, then leaves later output and resizing alone', async () => {
    const subscription = Promise.withResolvers<{ subscriptionId: string }>();
    invoke.mockImplementation((channel: string) => channel === 'fleet:subscribe' ? subscription.promise
      : channel === 'fleet:launch-claude' ? Promise.resolve({ shellIndex: 2 }) : Promise.resolve({ ok: true }));
    const app = mount();
    await flush();
    app.draw();
    const instance = terminal.instances[0];
    const chunks = Array.from({ length: 30 }, (_, index) => `line ${index}\n`);
    for (const chunk of chunks) app.emit(event('snapshot', chunk));
    app.emit(event('ready', ''));
    app.emit(event('data', 'queued live\n'));
    subscription.resolve({ subscriptionId: 'sub-1' });
    await flush();
    expect(instance?.writes).toEqual([...chunks, 'queued live\n']);
    expect(instance?.scrollToBottom).not.toHaveBeenCalled();
    for (let index = 0; index < chunks.length; index++) instance?.finishWrite();
    expect(instance?.scrollToBottom).not.toHaveBeenCalled();
    instance?.finishWrite();
    expect(instance?.scrollToBottom).toHaveBeenCalledOnce();
    app.draw();
    expect(instance?.parsed).toEqual([...chunks, '']);
    expect(instance?.buffer.active.viewportY).toBe(instance?.buffer.active.baseY);
    instance?.finishWrite();
    instance?.userScroll(3);
    app.emit(event('data', 'more output\n'));
    instance?.finishWrite();
    app.resizeHost(94, 30);
    app.draw();
    expect(instance?.buffer.active.viewportY).toBe(3);
    expect(instance?.scrollToBottom).toHaveBeenCalledOnce();
    expect(instance?.focus).toHaveBeenCalledOnce();
    instance?.data('pwd\r');
    await flush();
    expect(invoke).toHaveBeenCalledWith('fleet:write', { peerId: 'machine-b', projectId: 12, shellIndex: 2, data: 'pwd\r' });
  });

  it('does not expose an ordinary scrollback attachment as ready before its first bottom viewport is settled', async () => {
    const app = mount();
    await flush();
    app.draw();
    await flush();
    const instance = terminal.instances[0];
    app.emit(event('snapshot', Array.from({ length: 40 }, (_, index) => `line ${index}\n`).join('')));
    app.emit(event('data', 'first live update\n'));
    app.emit(event('ready', ''));
    app.draw();
    expect(app.visible()).toContain('Attaching terminal');
    expect(app.paneVisibility()).toEqual(['hidden']);
    expect(instance?.parsed).toEqual([]);
    instance?.finishWrite();
    instance?.finishWrite();
    expect(app.visible()).toContain('Attaching terminal');
    expect(app.paneVisibility()).toEqual(['hidden']);
    instance?.finishWrite();
    expect(app.visible()).not.toContain('Attaching terminal');
    expect(app.paneVisibility()).toEqual(['visible']);
    expect(instance?.buffer.active.viewportY).toBe(instance?.buffer.active.baseY);
    instance?.userScroll(2);
    app.emit(event('data', 'later update\n'));
    instance?.finishWrite();
    expect(instance?.buffer.active.viewportY).toBe(2);
  });

  it('does not expose an alternate-screen attachment as ready while its first frame is still parsing', async () => {
    const app = mount();
    await flush();
    app.draw();
    await flush();
    const instance = terminal.instances[0];
    app.emit(event('snapshot', '\u001b[?1049h'));
    app.emit(event('snapshot', '\u001b[Homp fullscreen'));
    app.emit(event('ready', ''));
    app.draw();
    expect(app.visible()).toContain('Attaching terminal');
    expect(app.paneVisibility()).toEqual(['hidden']);
    instance?.finishWrite();
    instance?.finishWrite();
    expect(app.visible()).toContain('Attaching terminal');
    expect(app.paneVisibility()).toEqual(['hidden']);
    instance?.finishWrite();
    expect(app.visible()).not.toContain('Attaching terminal');
    expect(app.paneVisibility()).toEqual(['visible']);
    expect(instance?.buffer.active).toBe(instance?.buffer.alternate);
    expect(instance?.buffer.active.viewportY).toBe(instance?.buffer.active.baseY);
  });

  it('does not override a deliberate scrollback gesture before the snapshot completes', async () => {
    const app = mount();
    await flush();
    app.draw();
    await flush();
    const instance = terminal.instances[0];
    for (let index = 0; index < 30; index++) app.emit(event('snapshot', `line ${index}\n`));
    app.emit(event('ready', ''));
    for (let index = 0; index < 29; index++) instance?.finishWrite();
    instance?.userScroll(0);
    for (let index = 29; index < 31; index++) instance?.callbacks.shift()?.();
    app.draw();
    expect(instance?.buffer.active.viewportY).toBe(0);
    expect(instance?.scrollToBottom).not.toHaveBeenCalled();
    expect(instance?.focus).toHaveBeenCalledOnce();
  });

  it('settles explicit reattachment once and ignores old callbacks and old subscription output', async () => {
    let nextSubscription = 0;
    invoke.mockImplementation((channel: string) => channel === 'fleet:subscribe'
      ? Promise.resolve({ subscriptionId: `sub-${++nextSubscription}` })
      : channel === 'fleet:launch-claude' ? Promise.resolve({ shellIndex: 2 }) : Promise.resolve({ ok: true }));
    const app = mount();
    await flush();
    app.draw();
    await flush();
    app.emit(event('snapshot', 'old\n', 'sub-1'));
    app.emit(event('ready', '', 'sub-1'));
    const previous = terminal.instances[0];
    app.control('Reconnect terminal').onClick();
    app.draw();
    await flush();
    const current = terminal.instances[1];
    expect(previous?.disposed).toBe(true);
    previous?.finishWrite();
    previous?.callbacks.shift()?.();
    expect(previous?.scrollToBottom).not.toHaveBeenCalled();
    app.emit(event('snapshot', 'wrong shell output\n', 'sub-1'));
    const chunks = Array.from({ length: 31 }, (_, index) => `fresh ${index}\n`);
    for (const chunk of chunks) app.emit(event('snapshot', chunk, 'sub-2'));
    app.emit(event('ready', '', 'sub-2'));
    app.emit(event('data', 'queued update\n', 'sub-2'));
    expect(current?.writes).toEqual([...chunks, 'queued update\n']);
    for (let index = 0; index < chunks.length; index++) current?.finishWrite();
    expect(current?.scrollToBottom).not.toHaveBeenCalled();
    current?.callbacks.shift()?.();
    expect(current?.buffer.active.viewportY).toBe(current?.buffer.active.baseY);
    expect(current?.scrollToBottom).toHaveBeenCalledOnce();
    current?.finishWrite();
    expect(current?.parsed).toEqual([...chunks, '', 'queued update\n']);
    app.draw();
    expect(current?.focus).toHaveBeenCalledOnce();
  });

  it('replays OSC 52 without allowing a clipboard read or output from a stale shell', async () => {
    const clipboard = { readText: vi.fn(async () => 'secret'), writeText: vi.fn(async () => undefined) };
    vi.stubGlobal('navigator', { clipboard });
    const app = mount();
    await flush();
    app.draw();
    await flush();
    app.emit(event('snapshot', '\u001b]52;c;?\u0007\u001b]52;x;c2VjcmV0\u0007'));
    app.emit(event('snapshot', `\u001b]52;c;${Buffer.from('intended copy').toString('base64')}\u0007`));
    app.emit(event('ready', ''));
    const instance = terminal.instances[0];
    instance?.finishWrite();
    instance?.finishWrite();
    instance?.callbacks.shift()?.();
    app.emit(event('snapshot', '\u001b]52;c;c3RhbGU=\u0007', 'stale-sub'));
    expect(clipboard.writeText).toHaveBeenCalledOnce();
    expect(clipboard.writeText).toHaveBeenCalledWith('intended copy');
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('fleet:write', expect.anything());
    expect(instance?.writes).not.toContain('\u001b]52;c;c3RhbGU=\u0007');
  });

  it('buffers only its own shell while subscribing, so a busy sibling shell cannot overflow it', async () => {
    invoke.mockImplementation((channel: string) => channel === 'fleet:subscribe' ? new Promise(() => undefined) : channel === 'fleet:launch-claude' ? Promise.resolve({ shellIndex: 2 }) : Promise.resolve({ ok: true }));
    const app = mount();
    await flush();
    app.draw();
    for (let index = 0; index < 2100; index++) app.emit({ ...event('data', 'x'), shellIndex: 3 });
    expect(app.visible()).not.toContain('exceeded the attachment buffer');
    for (let index = 0; index < 2100; index++) app.emit(event('data', 'x'));
    expect(app.visible()).toContain('exceeded the attachment buffer');
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

  it('never resizes a remote PTY after its pending attachment is abandoned', async () => {
    let finishSubscribe: (value: { subscriptionId: string }) => void = () => undefined;
    invoke.mockImplementation((channel: string) => channel === 'fleet:launch-claude'
      ? Promise.resolve({ shellIndex: 2 })
      : channel === 'fleet:subscribe'
        ? new Promise<{ subscriptionId: string }>((resolve) => { finishSubscribe = resolve; })
        : Promise.resolve({ ok: true }));
    const app = mount();
    await flush();
    app.draw();
    app.resizeHost(110, 40);
    app.offline();
    finishSubscribe({ subscriptionId: 'sub-1' });
    await flush();
    expect(invoke.mock.calls.filter(([channel]) => channel === 'fleet:resize')).toHaveLength(0);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'fleet:unsubscribe')).toHaveLength(1);
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

  it('keeps the first shell attached while selecting an existing second shell, then releases it after the second is ready', async () => {
    remote.shells = [shellRow(0, 'Claude'), shellRow(2, 'Terminal')];
    const second = Promise.withResolvers<{ subscriptionId: string }>();
    invoke.mockImplementation((channel: string, request?: { shellIndex?: number }) =>
      channel === 'fleet:subscribe'
        ? request?.shellIndex === 2 ? second.promise : Promise.resolve({ subscriptionId: 'sub-0' })
        : Promise.resolve({ ok: true }));
    const app = mount();
    await flush();
    app.draw();
    await flush();
    const first = terminal.instances[0];
    app.emit({ ...event('ready', '', 'sub-0'), shellIndex: 0 });
    app.bar().onSelect(2);
    app.draw();
    await flush();
    expect(invoke).toHaveBeenCalledWith('fleet:subscribe', { peerId: 'machine-b', projectId: 12, shellIndex: 2 });
    expect(invoke).not.toHaveBeenCalledWith('fleet:launch-claude', expect.anything());
    expect(invoke).not.toHaveBeenCalledWith('fleet:unsubscribe', { peerId: 'machine-b', subscriptionId: 'sub-0' });
    expect(first?.disposed).toBe(false);
    app.emit({ ...event('data', 'still attached', 'sub-0'), shellIndex: 0 });
    expect(first?.writes).toContain('still attached');
    first?.finishWrite();
    expect(app.visible()).toContain('Attaching terminal');
    second.resolve({ subscriptionId: 'sub-2' });
    await flush();
    app.emit(event('snapshot', 'second shell', 'sub-2'));
    app.emit(event('ready', '', 'sub-2'));
    terminal.instances.at(-1)?.finishWrite();
    terminal.instances.at(-1)?.finishWrite();
    app.draw();
    expect(app.bar().active).toBe(2);
    expect(invoke).toHaveBeenCalledWith('fleet:unsubscribe', { peerId: 'machine-b', subscriptionId: 'sub-0' });
    terminal.instances.at(-1)?.data('second shell\r');
    await flush();
    expect(invoke).toHaveBeenCalledWith('fleet:write', { peerId: 'machine-b', projectId: 12, shellIndex: 2, data: 'second shell\r' });
  });

  it('does not send focused old-shell input or report the new shell as shown during handoff', async () => {
    remote.shells = [shellRow(0, 'Claude'), shellRow(2, 'Terminal')];
    const second = Promise.withResolvers<{ subscriptionId: string }>();
    invoke.mockImplementation((channel: string, request?: { shellIndex?: number }) =>
      channel === 'fleet:subscribe'
        ? request?.shellIndex === 2 ? second.promise : Promise.resolve({ subscriptionId: 'sub-0' })
        : Promise.resolve({ ok: true }));
    const onShellsChange = vi.fn();
    const app = mount({ onShellsChange });
    await flush();
    app.draw();
    await flush();
    app.emit({ ...event('ready', '', 'sub-0'), shellIndex: 0 });
    const first = terminal.instances[0];
    first?.finishWrite();
    app.draw();
    first?.data('before switch\r');
    await flush();
    expect(invoke).toHaveBeenCalledWith('fleet:write', {
      peerId: 'machine-b', projectId: 12, shellIndex: 0, data: 'before switch\r',
    });

    app.bar().onSelect(2);
    app.draw();
    await flush();
    expect(app.paneVisibility()).toEqual(['hidden', 'hidden']);
    expect(onShellsChange).toHaveBeenLastCalledWith({ count: 2, shownShellIndex: null });
    first?.data('must not execute\r');
    await flush();
    expect(invoke).not.toHaveBeenCalledWith('fleet:write', expect.objectContaining({ data: 'must not execute\r' }));
    expect(invoke).not.toHaveBeenCalledWith('fleet:unsubscribe', { peerId: 'machine-b', subscriptionId: 'sub-0' });

    second.resolve({ subscriptionId: 'sub-2' });
    await flush();
    app.emit(event('ready', '', 'sub-2'));
    const replacement = terminal.instances.at(-1);
    replacement?.finishWrite();
    app.draw();
    expect(app.paneVisibility()).toEqual(['visible']);
    expect(onShellsChange).toHaveBeenLastCalledWith({ count: 2, shownShellIndex: 2 });
    replacement?.data('new shell\r');
    await flush();
    expect(invoke).toHaveBeenCalledWith('fleet:write', {
      peerId: 'machine-b', projectId: 12, shellIndex: 2, data: 'new shell\r',
    });
  });

  it('keeps the old controller until the replacement scroll area and bottom position are visible-ready', async () => {
    remote.shells = [shellRow(0, 'Claude'), shellRow(2, 'Terminal')];
    invoke.mockImplementation((channel: string, request?: { shellIndex?: number }) =>
      channel === 'fleet:subscribe'
        ? Promise.resolve({ subscriptionId: `sub-${request?.shellIndex}` })
        : Promise.resolve({ ok: true }));
    const app = mount();
    await flush();
    app.draw();
    await flush();
    app.emit({ ...event('ready', '', 'sub-0'), shellIndex: 0 });
    terminal.instances[0]?.finishWrite();
    app.draw();

    viewportGate.delayed = true;
    viewportGate.missing = true;
    app.bar().onSelect(2);
    app.draw();
    await flush();
    const replacement = terminal.instances.at(-1);
    app.emit(event('snapshot', Array.from({ length: 40 }, (_, index) => `line ${index}\n`).join(''), 'sub-2'));
    app.emit(event('ready', '', 'sub-2'));
    replacement?.finishWrite();
    replacement?.finishWrite();
    app.draw();
    expect(app.paneVisibility()).toEqual(['hidden', 'hidden']);
    expect(invoke).not.toHaveBeenCalledWith('fleet:unsubscribe', { peerId: 'machine-b', subscriptionId: 'sub-0' });
    expect(app.control('Paste').disabled).toBe(true);
    for (const callback of viewportGate.frames.splice(0)) callback(0);
    expect(app.paneVisibility()).toEqual(['hidden', 'hidden']);
    viewportGate.missing = false;
    for (const callback of viewportGate.frames.splice(0)) callback(16);
    expect(app.paneVisibility()).toEqual(['hidden', 'hidden']);

    const bottom = (replacement?.buffer.active.baseY ?? 0) * 16;
    expect(bottom).toBeGreaterThan(0);
    viewportGate.scrollHeight = 300 + bottom;
    for (const callback of viewportGate.frames.splice(0)) callback(32);
    expect(app.paneVisibility()).toEqual(['hidden', 'hidden']);
    viewportGate.scrollTop = bottom;
    for (const callback of viewportGate.frames.splice(0)) callback(48);
    app.draw();
    expect(app.paneVisibility()).toEqual(['visible']);
    expect(invoke).toHaveBeenCalledWith('fleet:unsubscribe', { peerId: 'machine-b', subscriptionId: 'sub-0' });
    expect(app.control('Paste').disabled).toBe(false);
  });

  it('reselects the previous tab during a pending second attachment without a control gap', async () => {
    remote.shells = [shellRow(0, 'Claude'), shellRow(2, 'Terminal')];
    const second = Promise.withResolvers<{ subscriptionId: string }>();
    invoke.mockImplementation((channel: string, request?: { shellIndex?: number }) =>
      channel === 'fleet:subscribe'
        ? request?.shellIndex === 2 ? second.promise : Promise.resolve({ subscriptionId: 'sub-0' })
        : Promise.resolve({ ok: true }));
    const app = mount();
    await flush();
    app.draw();
    await flush();
    app.emit({ ...event('ready', '', 'sub-0'), shellIndex: 0 });
    terminal.instances[0]?.finishWrite();
    app.draw();
    app.bar().onSelect(2);
    app.draw();
    await flush();
    app.bar().onSelect(0);
    app.draw();
    expect(app.paneShells()).toEqual([0]);
    expect(app.bar().active).toBe(0);
    expect(terminal.instances[0]?.disposed).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith('fleet:unsubscribe', { peerId: 'machine-b', subscriptionId: 'sub-0' });
    second.resolve({ subscriptionId: 'sub-2' });
    await flush();
    expect(invoke).toHaveBeenCalledWith('fleet:unsubscribe', { peerId: 'machine-b', subscriptionId: 'sub-2' });
    terminal.instances[0]?.data('kept shell\r');
    await flush();
    expect(invoke).toHaveBeenCalledWith('fleet:write', { peerId: 'machine-b', projectId: 12, shellIndex: 0, data: 'kept shell\r' });
  });

  it('restores the previous tab and attachment when the replacement subscription fails', async () => {
    vi.stubGlobal('navigator', { clipboard: { readText: vi.fn(async () => 'old shell\r') } });
    remote.shells = [shellRow(0, 'Claude'), shellRow(2, 'Terminal')];
    invoke.mockImplementation((channel: string, request?: { shellIndex?: number }) =>
      channel === 'fleet:subscribe'
        ? request?.shellIndex === 2 ? Promise.reject(new Error('subscription denied')) : Promise.resolve({ subscriptionId: 'sub-0' })
        : Promise.resolve({ ok: true }));
    const app = mount();
    await flush();
    app.draw();
    await flush();
    app.emit({ ...event('ready', '', 'sub-0'), shellIndex: 0 });
    terminal.instances[0]?.finishWrite();
    app.draw();
    app.bar().onSelect(2);
    app.draw();
    await flush();
    app.draw();
    expect(app.bar().active).toBe(0);
    expect(app.paneShells()).toEqual([0]);
    expect(terminal.instances[0]?.disposed).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith('fleet:unsubscribe', { peerId: 'machine-b', subscriptionId: 'sub-0' });
    expect(toast).toHaveBeenCalledWith('Could not attach remote terminal. Check the connection and retry.', { kind: 'error' });
    expect(app.control('Paste').disabled).toBe(false);
    app.control('Paste').onClick();
    await flush();
    expect(invoke).toHaveBeenCalledWith('fleet:write', { peerId: 'machine-b', projectId: 12, shellIndex: 0, data: 'old shell\r' });
  });

  it('keeps the previous shell when the replacement exits before its initial viewport is ready', async () => {
    remote.shells = [shellRow(0, 'Claude'), shellRow(2, 'Terminal')];
    invoke.mockImplementation((channel: string, request?: { shellIndex?: number }) =>
      channel === 'fleet:subscribe'
        ? Promise.resolve({ subscriptionId: `sub-${request?.shellIndex}` })
        : Promise.resolve({ ok: true }));
    const app = mount();
    await flush();
    app.draw();
    await flush();
    app.emit({ ...event('ready', '', 'sub-0'), shellIndex: 0 });
    terminal.instances[0]?.finishWrite();
    app.draw();
    app.bar().onSelect(2);
    app.draw();
    await flush();
    app.emit(event('exit', '0', 'sub-2'));
    app.draw();
    expect(app.bar().active).toBe(0);
    expect(app.paneShells()).toEqual([0]);
    expect(terminal.instances[0]?.disposed).toBe(false);
    expect(invoke).toHaveBeenCalledWith('fleet:unsubscribe', { peerId: 'machine-b', subscriptionId: 'sub-2' });
    expect(invoke).not.toHaveBeenCalledWith('fleet:unsubscribe', { peerId: 'machine-b', subscriptionId: 'sub-0' });
  });

  it('releases the old attachment and a late replacement acknowledgment when the project unmounts mid-handoff', async () => {
    remote.shells = [shellRow(0, 'Claude'), shellRow(2, 'Terminal')];
    const second = Promise.withResolvers<{ subscriptionId: string }>();
    invoke.mockImplementation((channel: string, request?: { shellIndex?: number }) =>
      channel === 'fleet:subscribe'
        ? request?.shellIndex === 2 ? second.promise : Promise.resolve({ subscriptionId: 'sub-0' })
        : Promise.resolve({ ok: true }));
    const app = mount();
    await flush();
    app.draw();
    await flush();
    app.bar().onSelect(2);
    app.draw();
    runtime.unmount();
    expect(invoke).toHaveBeenCalledWith('fleet:unsubscribe', { peerId: 'machine-b', subscriptionId: 'sub-0' });
    second.resolve({ subscriptionId: 'sub-2' });
    await flush();
    expect(invoke).toHaveBeenCalledWith('fleet:unsubscribe', { peerId: 'machine-b', subscriptionId: 'sub-2' });
  });

  it('does not relaunch or reattach when the already selected second tab receives a refreshed shell list', async () => {
    remote.shells = [shellRow(0, 'Claude'), shellRow(2, 'Terminal')];
    const app = mount({ focusShell: { shellIndex: 2, seq: 1 } });
    await flush();
    app.draw();
    await flush();
    const current = terminal.instances[0];
    const subscriptions = invoke.mock.calls.filter(([channel]) => channel === 'fleet:subscribe').length;
    app.bar().onSelect(2);
    remote.shells = [shellRow(0, 'Claude'), shellRow(2, 'Terminal')];
    app.draw();
    await flush();
    app.draw();
    expect(app.bar().active).toBe(2);
    expect(current?.disposed).toBe(false);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'fleet:subscribe')).toHaveLength(subscriptions);
    expect(invoke).not.toHaveBeenCalledWith('fleet:launch-claude', expect.anything());
  });

  it('launches saved and custom agents on the peer, not the controller, and selects each new tab', async () => {
    remote.shells = [shellRow(0, 'Claude')];
    invoke.mockImplementation((channel: string) => {
      if (channel === 'fleet:launch-cli') {
        const next = remote.shells.length + 1;
        remote.shells = [...remote.shells, shellRow(next, next === 2 ? 'Pi' : 'Llama')];
        return Promise.resolve({ shellIndex: next });
      }
      if (channel === 'fleet:subscribe') return Promise.resolve({ subscriptionId: 'sub-1' });
      return Promise.resolve({ ok: true });
    });
    const app = mount();
    await flush();
    app.draw();
    app.bar().onLaunchProfile('Pi');
    await flush();
    app.draw();
    expect(invoke).toHaveBeenCalledWith('fleet:launch-cli', { peerId: 'machine-b', projectId: 12, profileName: 'Pi' });
    expect(app.bar().active).toBe(2);
    app.bar().onLaunchCustom('Llama', 'llama chat --model "tiny local"', true);
    await flush();
    app.draw();
    expect(invoke).toHaveBeenCalledWith('fleet:launch-cli', {
      peerId: 'machine-b', projectId: 12, profileName: 'Llama',
      argv: ['llama', 'chat', '--model', 'tiny local'], save: true,
    });
    expect(app.bar().active).toBe(3);
    expect(app.bar().shells.map(({ launchName }) => launchName)).toEqual(['Claude', 'Pi', 'Llama']);
    expect(invoke).not.toHaveBeenCalledWith('shells:launch-cli', expect.anything());
  });

  it('ignores stale status replies after a newer refresh lists a newly launched tab', async () => {
    remote.shells = [shellRow(0, 'Claude')];
    const old = Promise.withResolvers<{ roots: never[]; projects: never[]; shells: FleetShell[] }>();
    let statusCalls = 0;
    remote.status = () => {
      statusCalls++;
      return statusCalls === 2 ? old.promise : Promise.resolve({ roots: [], projects: [], shells: remote.shells });
    };
    let refresh!: () => void;
    vi.stubGlobal('setInterval', (callback: () => void) => { refresh = callback; return 1; });
    vi.stubGlobal('clearInterval', vi.fn());
    invoke.mockImplementation((channel: string) => {
      if (channel === 'fleet:launch') {
        remote.shells = [shellRow(0, 'Claude'), shellRow(2, 'Terminal')];
        return Promise.resolve({ shellIndex: 2 });
      }
      if (channel === 'fleet:subscribe') return Promise.resolve({ subscriptionId: 'sub-1' });
      return Promise.resolve({ ok: true });
    });
    const app = mount();
    await flush();
    app.draw();
    app.bar().onLaunchPlainTab();
    await flush();
    refresh();
    await flush();
    app.draw();
    old.resolve({ roots: [], projects: [], shells: [shellRow(0, 'Claude')] });
    await flush();
    expect(statusCalls).toBe(3);
    expect(app.bar().shells.map(({ shellIndex }) => shellIndex)).toEqual([0, 2]);
  });

  it('closes one remote tab and selects a surviving tab without stopping its PTY', async () => {
    remote.shells = [shellRow(0, 'Claude'), shellRow(2, 'Pi')];
    const app = mount();
    await flush();
    app.draw();
    app.bar().onSelect(2);
    app.draw();
    app.bar().onClose(2);
    await flush();
    app.draw();
    expect(invoke).toHaveBeenCalledWith('fleet:stop', { peerId: 'machine-b', projectId: 12, shellIndex: 2 });
    expect(app.bar().active).toBe(0);
    expect(app.bar().shells.map(({ shellIndex }) => shellIndex)).toEqual([0]);
    expect(invoke).not.toHaveBeenCalledWith('fleet:stop', { peerId: 'machine-b', projectId: 12, shellIndex: 0 });
  });

  it('manages remote CLI defaults and profile removal through authenticated Fleet operations', async () => {
    remote.shells = [shellRow(0, 'Claude')];
    invoke.mockImplementation((channel: string) => {
      if (channel === 'fleet:set-default-cli') return Promise.resolve({ defaultCliName: 'Pi' });
      return Promise.resolve({ ok: true });
    });
    const app = mount();
    await flush();
    const menu = app.bar().remoteMenu;
    expect(menu).toBeDefined();
    await menu!.setDefault('Pi');
    await menu!.remove('Pi');
    expect(invoke).toHaveBeenCalledWith('fleet:set-default-cli', { peerId: 'machine-b', projectId: 12, name: 'Pi' });
    expect(invoke).toHaveBeenCalledWith('fleet:remove-cli-profile', { peerId: 'machine-b', projectId: 12, name: 'Pi' });
    expect(app.bar().defaultCliName).toBe('Pi');
    expect(invoke).not.toHaveBeenCalledWith('shells:set-default-cli', expect.anything());
  });

  it('reattaches an existing remote shell on reconnect without launching another agent', async () => {
    const app = mount();
    await flush();
    app.draw();
    await flush();
    remote.shells = [shellRow(2, 'Claude')];
    app.offline();
    app.online();
    await flush();
    app.draw();
    expect(invoke.mock.calls.filter(([channel]) => channel === 'fleet:launch-claude')).toHaveLength(1);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'fleet:subscribe')).toHaveLength(2);
    expect(invoke).not.toHaveBeenCalledWith('shells:launch', expect.anything());
  });

  it('replaces the subscription when retry reattaches the same Claude shell index', async () => {
    const app = mount();
    await flush();
    app.draw();
    await flush();
    const first = terminal.instances[0];
    app.control('Reconnect terminal').onClick();
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
    terminal.instances[0]?.finishWrite();
    app.draw();
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
    expect(renderToStaticMarkup(app.draw())).toContain('role="alert"');
    expect(app.visible()).not.toContain('private launch command');
    app.bar().onLaunchPlainTab();
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

  it('fits before subscription but resizes only after acknowledgement using latest measured viewport', async () => {
    let resolve: (value: { subscriptionId: string }) => void = () => undefined;
    invoke.mockImplementation((channel: string) => channel === 'fleet:launch-claude'
      ? Promise.resolve({ shellIndex: 2 })
      : channel === 'fleet:subscribe'
        ? new Promise<{ subscriptionId: string }>((done) => { resolve = done; })
        : Promise.resolve({ ok: true }));
    const app = mount();
    await flush();
    app.draw();
    expect(fits.count).toBeGreaterThan(0);
    app.resizeHost(102, 32);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'fleet:resize')).toHaveLength(0);
    resolve({ subscriptionId: 'sub-1' });
    await flush();
    expect(invoke.mock.calls.filter(([channel]) => channel === 'fleet:resize').map(([, request]) => request)).toEqual([
      { peerId: 'machine-b', projectId: 12, shellIndex: 2, cols: 102, rows: 32 },
    ]);
  });

  it('refits on viewport and font updates without repeating PTY geometry', async () => {
    const app = mount();
    await flush();
    app.draw();
    await flush();
    const initialFits = fits.count;
    app.resizeHost(80, 24);
    expect(fits.count).toBeGreaterThan(initialFits);
    fits.dimensions = { cols: 74, rows: 20 };
    font.size = 16;
    app.draw();
    expect(fits.count).toBeGreaterThan(initialFits + 1);
    app.resizeHost(100, 31);
    app.resizeHost(100, 31);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'fleet:resize').map(([, request]) => [request.cols, request.rows])).toEqual([
      [80, 24], [74, 20], [100, 31],
    ]);
    app.emit(event('exit', '0'));
    app.resizeHost(120, 40);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'fleet:resize')).toHaveLength(3);
    expect(invoke).toHaveBeenCalledWith('fleet:unsubscribe', { peerId: 'machine-b', subscriptionId: 'sub-1' });
  });

  it('routes terminal paste shortcut into the remote PTY without local shell input', async () => {
    const clipboard = { readText: vi.fn(async () => 'remote paste\r'), writeText: vi.fn(async () => undefined) };
    vi.stubGlobal('navigator', { clipboard });
    const app = mount();
    await flush();
    app.draw();
    await flush();
    app.emit(event('ready', ''));
    terminal.instances[0]?.finishWrite();
    app.draw();
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

  it('has no inert Shell button in the header, while the shell tabs and header controls stay', async () => {
    remote.shells = [shellRow(0, 'Claude')];
    const app = mount();
    await flush();
    const tree = app.draw();
    const buttons = nodes(tree).filter((node) => node.type === 'button');
    expect(buttons.map((node) => text((node.props as { children?: ReactNode }).children))).not.toContain('Shell');
    expect(buttons.some((node) => (node.props as { 'aria-current'?: string })['aria-current'] === 'page')).toBe(false);
    expect(app.bar().shells).toHaveLength(1);
    expect(app.control('Reconnect terminal')).toBeDefined();
    expect(app.control('Paste')).toBeDefined();
    expect(app.control('Stop remote shell')).toBeDefined();
  });

  it('reports the live shell count and the shown shell, and null while offline', async () => {
    remote.shells = [shellRow(0, 'Claude'), shellRow(2, 'Terminal')];
    const onShellsChange = vi.fn();
    const app = mount({ onShellsChange });
    await flush();
    app.draw();
    expect(onShellsChange).toHaveBeenLastCalledWith({ count: 2, shownShellIndex: 0 });
    app.bar().onSelect(2);
    app.draw();
    expect(onShellsChange).toHaveBeenLastCalledWith({ count: 2, shownShellIndex: null });
    const calls = onShellsChange.mock.calls.length;
    app.draw();
    expect(onShellsChange).toHaveBeenCalledTimes(calls);
    await flush();
    app.emit(event('ready', '', 'sub-1'));
    terminal.instances.at(-1)?.finishWrite();
    app.draw();
    expect(onShellsChange).toHaveBeenLastCalledWith({ count: 2, shownShellIndex: 2 });
    app.offline();
    expect(onShellsChange).toHaveBeenLastCalledWith({ count: 2, shownShellIndex: null });
  });

  it('opens on the requested shell instead of shell 0 when mounted for a notice', async () => {
    remote.shells = [shellRow(0, 'Claude'), shellRow(2, 'Terminal')];
    const app = mount({ focusShell: { shellIndex: 2, seq: 1 } });
    await flush();
    app.draw();
    await flush();
    expect(app.bar().active).toBe(2);
    expect(invoke).toHaveBeenCalledWith('fleet:subscribe', { peerId: 'machine-b', projectId: 12, shellIndex: 2 });
    expect(invoke).not.toHaveBeenCalledWith('fleet:subscribe', { peerId: 'machine-b', projectId: 12, shellIndex: 0 });
  });

  it('falls back to shell 0 when the requested shell is not on the peer', async () => {
    remote.shells = [shellRow(0, 'Claude'), shellRow(2, 'Terminal')];
    const app = mount({ focusShell: { shellIndex: 5, seq: 1 } });
    await flush();
    app.draw();
    expect(app.bar().active).toBe(0);
    expect(invoke).not.toHaveBeenCalledWith('fleet:launch-claude', expect.anything());
  });

  it('switches an open project to a newly requested shell once, leaving later manual picks alone', async () => {
    remote.shells = [shellRow(0, 'Claude'), shellRow(2, 'Terminal')];
    const app = mount();
    await flush();
    app.draw();
    expect(app.bar().active).toBe(0);
    app.props({ focusShell: { shellIndex: 2, seq: 1 } });
    app.draw();
    expect(app.bar().active).toBe(2);
    app.bar().onSelect(0);
    app.draw();
    remote.shells = [shellRow(0, 'Claude'), shellRow(2, 'Terminal')];
    app.draw();
    expect(app.bar().active).toBe(0);
    app.props({ focusShell: { shellIndex: 2, seq: 2 } });
    app.draw();
    expect(app.bar().active).toBe(2);
  });
  it('puts an OSC 52 write from the remote PTY on the local clipboard, write-only', async () => {
    const clipboard = { readText: vi.fn(async () => 'never read'), writeText: vi.fn(async () => undefined) };
    vi.stubGlobal('navigator', { clipboard });
    const app = mount();
    await flush();
    app.draw();
    await flush();
    app.emit(event('ready', ''));
    const handler = terminal.instances[0]?.osc.get(52);
    expect(handler).toBeDefined();
    expect(handler?.('c;?')).toBe(true);
    expect(handler?.('x;cmVtb3Rl')).toBe(true);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(handler?.(`c;${Buffer.from('remote copy').toString('base64')}`)).toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith('remote copy');
    await flush();
    await flush();
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('fleet:write', expect.anything());
  });

  it('shows the remote clipboard toast when an OSC 52 write fails', async () => {
    vi.stubGlobal('navigator', { clipboard: { readText: vi.fn(), writeText: vi.fn(() => Promise.reject(new Error('denied'))) } });
    const app = mount();
    await flush();
    app.draw();
    await flush();
    expect(toast).not.toHaveBeenCalled();
    terminal.instances[0]?.osc.get(52)?.(`c;${Buffer.from('x').toString('base64')}`);
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Remote terminal clipboard failed', expect.objectContaining({ kind: 'error' })));
  });

  it('disposes the OSC 52 handler with its terminal', async () => {
    const app = mount();
    await flush();
    app.draw();
    await flush();
    const instance = terminal.instances[0];
    expect(instance?.oscDisposed).toBe(0);
    app.offline();
    expect(instance?.disposed).toBe(true);
    expect(instance?.oscDisposed).toBe(1);
  });
});

describe('RemoteTerminal split', () => {
  const shellEvent = (shellIndex: number, kind: FleetTerminalEvent['kind'], data: string): FleetTerminalEvent => ({ peerId: 'machine-b', projectId: 12, shellIndex, subscriptionId: `sub-${shellIndex}`, kind, data });
  let launches: Array<() => Promise<{ shellIndex: number }>>;
  beforeEach(() => {
    remote.shells = [shellRow(0, 'Claude'), shellRow(2, 'Pi')];
    launches = [];
    invoke.mockImplementation((channel: string, request?: { shellIndex?: number }) => {
      if (channel === 'fleet:launch') {
        const next = launches.shift();
        if (next) return next();
        remote.shells = [...remote.shells, shellRow(3, 'Terminal')];
        return Promise.resolve({ shellIndex: 3 });
      }
      if (channel === 'fleet:subscribe') return Promise.resolve({ subscriptionId: `sub-${request?.shellIndex}` });
      if (channel === 'fleet:stop') remote.shells = remote.shells.filter((shell) => shell.shellIndex !== request?.shellIndex);
      return Promise.resolve({ ok: true });
    });
  });
  async function opened() {
    const app = mount();
    await flush();
    app.draw();
    await flush();
    expect(app.bar().splitOn).toBe(false);
    expect(app.paneShells()).toEqual([0]);
    app.bar().onToggleSplit?.();
    await flush();
    app.draw();
    await flush();
    app.draw();
    return app;
  }
  const rightHeader = (app: ReturnType<typeof mount>) => {
    const header = app.find<ReactModule.ComponentProps<typeof SplitPaneHeader>>(SplitPaneHeader).find((props) => props.actions);
    if (!header?.actions) throw new Error('Missing right pane header');
    return header.actions;
  };

  it('offers the split toggle and, when turned on, launches a plain shell shown beside the current one', async () => {
    const app = await opened();
    expect(invoke).toHaveBeenCalledWith('fleet:launch', { peerId: 'machine-b', projectId: 12 });
    expect(app.bar().splitOn).toBe(true);
    expect(app.paneShells()).toEqual([0, 3]);
    expect(app.bar().active).toBe(0);
    expect(invoke).toHaveBeenCalledWith('fleet:subscribe', { peerId: 'machine-b', projectId: 12, shellIndex: 3 });
    expect(terminal.instances[0]?.disposed).toBe(false);
    expect(terminal.instances).toHaveLength(2);
  });

  it('keeps the right shell out of the tab strip so it is never the active left tab', async () => {
    const app = await opened();
    expect(app.bar().shells.map(({ shellIndex }) => shellIndex)).toEqual([0, 2]);
    expect(app.bar().active).not.toBe(3);
    app.props({ focusShell: { shellIndex: 3, seq: 1 } });
    app.draw();
    expect(app.bar().active).toBe(0);
    expect(app.paneShells()).toEqual([0, 3]);
  });

  it('keeps the selected left attachment during split launch, delayed right readiness, and an older status reply', async () => {
    const stale = Promise.withResolvers<{ roots: never[]; projects: never[]; shells: FleetShell[] }>();
    let poll: (() => void) | undefined;
    vi.stubGlobal('setInterval', (callback: () => void) => { poll = callback; return 1; });
    vi.stubGlobal('clearInterval', vi.fn());
    const rightSubscription = Promise.withResolvers<{ subscriptionId: string }>();
    invoke.mockImplementation((channel: string, request?: { shellIndex?: number }) => {
      if (channel === 'fleet:launch') {
        remote.shells = [...remote.shells, shellRow(3, 'Terminal')];
        return Promise.resolve({ shellIndex: 3 });
      }
      if (channel === 'fleet:subscribe')
        return request?.shellIndex === 3 ? rightSubscription.promise : Promise.resolve({ subscriptionId: `sub-${request?.shellIndex}` });
      return Promise.resolve({ ok: true });
    });
    const app = mount();
    await flush();
    app.draw();
    await flush();
    app.bar().onSelect(2);
    app.draw();
    await flush();
    const left = terminal.instances.at(-1);
    app.emit(shellEvent(2, 'ready', ''));
    left?.finishWrite();
    app.draw();
    remote.status = () => stale.promise;
    poll?.();
    remote.status = null;
    app.bar().onToggleSplit?.();
    expect(app.bar().active).toBe(2);
    expect(left?.disposed).toBe(false);
    await flush();
    app.draw();
    await flush();
    expect(app.bar().active).toBe(2);
    expect(app.paneShells()).toEqual([2, 3]);
    expect(left?.disposed).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith('fleet:unsubscribe', { peerId: 'machine-b', subscriptionId: 'sub-2' });
    stale.resolve({ roots: [], projects: [], shells: [shellRow(0, 'Claude'), shellRow(2, 'Pi')] });
    await flush();
    app.draw();
    expect(app.bar().active).toBe(2);
    expect(app.paneShells()).toEqual([2, 3]);
    rightSubscription.resolve({ subscriptionId: 'sub-3' });
    await flush();
    app.emit(shellEvent(3, 'ready', ''));
    terminal.instances.at(-1)?.finishWrite();
    app.draw();
    expect(app.bar().active).toBe(2);
    expect(app.paneShells()).toEqual([2, 3]);
    expect(left?.disposed).toBe(false);
  });

  it('attaches each pane independently for output, input, resize and copy', async () => {
    vi.stubGlobal('navigator', { clipboard: { readText: vi.fn(async () => ''), writeText: vi.fn(async () => undefined) } });
    const app = await opened();
    const [left, right] = terminal.instances;
    app.emit(shellEvent(0, 'ready', ''));
    app.emit(shellEvent(3, 'ready', ''));
    app.emit(shellEvent(3, 'data', 'right only'));
    app.emit(shellEvent(0, 'data', 'left only'));
    expect(right?.writes).toEqual(['right only']);
    expect(left?.writes).toEqual(['left only']);
    right?.finishWrite();
    left?.finishWrite();
    right?.data('ls\r');
    left?.data('pwd\r');
    await flush();
    expect(invoke).toHaveBeenCalledWith('fleet:write', { peerId: 'machine-b', projectId: 12, shellIndex: 3, data: 'ls\r' });
    expect(invoke).toHaveBeenCalledWith('fleet:write', { peerId: 'machine-b', projectId: 12, shellIndex: 0, data: 'pwd\r' });
    expect(invoke).toHaveBeenCalledWith('fleet:resize', { peerId: 'machine-b', projectId: 12, shellIndex: 3, cols: 80, rows: 24 });
    expect(right?.osc.get(52)).toBeDefined();
    expect(right?.osc.get(52)).not.toBe(left?.osc.get(52));
  });

  it('keeps left scrollback while the right alternate screen settles after parsing', async () => {
    const app = await opened();
    const [left, right] = terminal.instances;
    app.emit(shellEvent(0, 'snapshot', Array.from({ length: 32 }, (_, index) => `left ${index}\n`).join('')));
    app.emit(shellEvent(0, 'ready', ''));
    app.emit(shellEvent(3, 'snapshot', '\u001b[?1049h'));
    app.emit(shellEvent(3, 'snapshot', '\u001b[Hright fullscreen'));
    app.emit(shellEvent(3, 'ready', ''));
    left?.finishWrite();
    left?.userScroll(0);
    left?.callbacks.shift()?.();
    right?.finishWrite();
    right?.finishWrite();
    expect(right?.buffer.active).toBe(right?.buffer.alternate);
    expect(right?.scrollToBottom).not.toHaveBeenCalled();
    right?.callbacks.shift()?.();
    expect(right?.scrollToBottom).toHaveBeenCalledOnce();
    expect(left?.scrollToBottom).not.toHaveBeenCalled();
    expect(left?.buffer.active.viewportY).toBe(0);
    expect(right?.parsed).toEqual(['\u001b[?1049h', '\u001b[Hright fullscreen', '']);
    app.emit(shellEvent(3, 'data', ' right update'));
    right?.finishWrite();
    app.resizeHost(90, 28);
    expect(right?.scrollToBottom).toHaveBeenCalledOnce();
    expect(left?.scrollToBottom).not.toHaveBeenCalled();
    right?.data('q');
    await flush();
    expect(invoke).toHaveBeenCalledWith('fleet:write', { peerId: 'machine-b', projectId: 12, shellIndex: 3, data: 'q' });
  });

  it('turning the split off stops the right shell and keeps the left attachment', async () => {
    const app = await opened();
    const [left, right] = terminal.instances;
    app.bar().onToggleSplit?.();
    await flush();
    app.draw();
    expect(invoke).toHaveBeenCalledWith('fleet:stop', { peerId: 'machine-b', projectId: 12, shellIndex: 3 });
    expect(invoke).not.toHaveBeenCalledWith('fleet:stop', expect.objectContaining({ shellIndex: 0 }));
    expect(right?.disposed).toBe(true);
    expect(invoke).toHaveBeenCalledWith('fleet:unsubscribe', { peerId: 'machine-b', subscriptionId: 'sub-3' });
    expect(left?.disposed).toBe(false);
    expect(app.bar().splitOn).toBe(false);
    expect(app.paneShells()).toEqual([0]);
    expect(app.bar().shells.map(({ shellIndex }) => shellIndex)).toEqual([0, 2]);
  });

  it('the right pane close button stops its shell too', async () => {
    const app = await opened();
    rightHeader(app).onClose();
    await flush();
    app.draw();
    expect(invoke).toHaveBeenCalledWith('fleet:stop', { peerId: 'machine-b', projectId: 12, shellIndex: 3 });
    expect(app.bar().splitOn).toBe(false);
  });

  it('moves the right shell to its own tab without stopping it', async () => {
    const app = await opened();
    rightHeader(app).onToTab();
    await flush();
    app.draw();
    expect(invoke).not.toHaveBeenCalledWith('fleet:stop', expect.anything());
    expect(app.bar().splitOn).toBe(false);
    expect(app.bar().shells.map(({ shellIndex }) => shellIndex)).toEqual([0, 2, 3]);
    expect(app.bar().active).toBe(3);
  });

  it('shows a toast and no split when the launch fails', async () => {
    launches.push(() => Promise.reject(new Error('private launch failure')));
    const app = mount();
    await flush();
    app.draw();
    app.bar().onToggleSplit?.();
    await flush();
    app.draw();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('split'), expect.objectContaining({ kind: 'error' }));
    expect(JSON.stringify(toast.mock.calls)).not.toContain('private launch failure');
    expect(app.bar().splitOn).toBe(false);
    expect(app.paneShells()).toEqual([0]);
    expect(app.visible()).not.toContain('Could not open');
  });

  it('launches once when the toggle is pressed again while the split is opening', async () => {
    let finish!: (value: { shellIndex: number }) => void;
    launches.push(() => new Promise((resolve) => { finish = resolve; }));
    const app = mount();
    await flush();
    app.draw();
    app.bar().onToggleSplit?.();
    app.bar().onToggleSplit?.();
    finish({ shellIndex: 3 });
    await flush();
    app.draw();
    expect(invoke.mock.calls.filter(([channel]) => channel === 'fleet:launch')).toHaveLength(1);
    expect(app.paneShells()).toEqual([0, 3]);
    expect(invoke).not.toHaveBeenCalledWith('fleet:stop', expect.anything());
  });

  it('the header Paste button pastes into the left pane only', async () => {
    const clipboard = { readText: vi.fn(async () => 'header paste'), writeText: vi.fn(async () => undefined) };
    vi.stubGlobal('navigator', { clipboard });
    const app = await opened();
    app.emit(shellEvent(0, 'ready', ''));
    app.emit(shellEvent(3, 'ready', ''));
    terminal.instances[0]?.finishWrite();
    terminal.instances[1]?.finishWrite();
    app.draw();
    app.draw();
    app.control('Paste').onClick();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('fleet:write', { peerId: 'machine-b', projectId: 12, shellIndex: 0, data: 'header paste' }));
    expect(invoke).not.toHaveBeenCalledWith('fleet:write', expect.objectContaining({ shellIndex: 3 }));
  });

  it('keeps the right pane while the left tab switches', async () => {
    const app = await opened();
    const right = terminal.instances[1];
    app.bar().onSelect(2);
    app.draw();
    await flush();
    expect(app.paneShells()).toEqual([0, 2, 3]);
    expect(right?.disposed).toBe(false);
    expect(terminal.instances[0]?.disposed).toBe(false);
    app.emit(shellEvent(2, 'ready', ''));
    terminal.instances.at(-1)?.finishWrite();
    app.draw();
    expect(app.paneShells()).toEqual([2, 3]);
    expect(terminal.instances[0]?.disposed).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith('fleet:unsubscribe', { peerId: 'machine-b', subscriptionId: 'sub-3' });
  });

  it('closes the split when the right shell exits', async () => {
    const app = await opened();
    app.emit(shellEvent(3, 'ready', ''));
    app.draw();
    expect(app.bar().splitOn).toBe(true);
    app.emit(shellEvent(3, 'exit', '0'));
    app.draw();
    expect(app.bar().splitOn).toBe(false);
    expect(app.paneShells()).toEqual([0]);
    expect(terminal.instances[0]?.disposed).toBe(false);
  });

  it('closes the split when its shell is stopped elsewhere, but not before the peer first lists it', async () => {
    let poll!: () => void;
    vi.stubGlobal('setInterval', (callback: () => void) => { poll = callback; return 1; });
    vi.stubGlobal('clearInterval', vi.fn());
    const listed = remote.shells;
    remote.status = () => Promise.resolve({ roots: [], projects: [], shells: listed });
    const app = await opened();
    expect(app.paneShells()).toEqual([0, 3]);
    remote.status = null;
    poll();
    await flush();
    app.draw();
    expect(app.paneShells()).toEqual([0, 3]);
    remote.shells = remote.shells.filter((shell) => shell.shellIndex !== 3);
    poll();
    await flush();
    app.draw();
    app.draw();
    expect(app.bar().splitOn).toBe(false);
    expect(app.paneShells()).toEqual([0]);
    expect(invoke).not.toHaveBeenCalledWith('fleet:stop', expect.anything());
  });

  it('uses the shared gutter at the local default ratio and follows its changes', async () => {
    const app = await opened();
    const gutter = () => app.find<ReactModule.ComponentProps<typeof SplitGutter>>(SplitGutter)[0];
    expect(gutter()?.ratio).toBe(SPLIT_RATIO_DEFAULT);
    gutter()?.onRatioChange(0.3);
    expect(gutter()?.ratio).toBe(0.3);
  });

  it('promotes the right shell to the left on reconnect when the left shell has gone', async () => {
    const app = await opened();
    expect(app.paneShells()).toEqual([0, 3]);
    app.offline();
    remote.shells = [shellRow(3, 'Terminal')];
    app.online();
    await flush();
    app.draw();
    app.draw();
    expect(app.paneShells()).toEqual([3]);
    expect(app.bar().splitOn).toBe(false);
    expect(app.bar().active).toBe(3);
    expect(app.bar().shells.map(({ shellIndex }) => shellIndex)).toEqual([3]);
  });

  it('keeps the split on reconnect while another shell can take the left pane', async () => {
    const app = await opened();
    app.offline();
    remote.shells = [shellRow(2, 'Pi'), shellRow(3, 'Terminal')];
    app.online();
    await flush();
    app.draw();
    app.draw();
    expect(app.paneShells()).toEqual([2, 3]);
    expect(app.bar().splitOn).toBe(true);
  });

  it('promotes the right shell when a reconnect focus request targets it', async () => {
    const app = await opened();
    app.offline();
    app.props({ focusShell: { shellIndex: 3, seq: 1 } });
    app.online();
    await flush();
    app.draw();
    app.draw();
    expect(app.paneShells()).toEqual([3]);
    expect(app.bar().splitOn).toBe(false);
    expect(app.bar().active).toBe(3);
  });

  it('stops a split shell whose launch resolves after the terminal unmounted', async () => {
    let finish!: (value: { shellIndex: number }) => void;
    launches.push(() => new Promise((resolve) => { finish = resolve; }));
    const app = mount();
    await flush();
    app.draw();
    app.bar().onToggleSplit?.();
    runtime.unmount();
    expect(invoke).not.toHaveBeenCalledWith('fleet:stop', expect.anything());
    finish({ shellIndex: 3 });
    await flush();
    expect(invoke).toHaveBeenCalledWith('fleet:stop', { peerId: 'machine-b', projectId: 12, shellIndex: 3 });
  });

  it('promotes the right shell to the left when the last other shell is stopped', async () => {
    remote.shells = [shellRow(0, 'Claude')];
    const app = await opened();
    app.control('Stop remote shell').onClick();
    await flush();
    app.draw();
    expect(app.paneShells()).toEqual([3]);
    expect(app.bar().splitOn).toBe(false);
    expect(app.bar().active).toBe(3);
  });
});
