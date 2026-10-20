/** Fleet panel tests cover explicit trust, linked-only controls, stale replies, escaped terminal text and actionable failures. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FleetState, FleetStatus } from '@shared/fleet-contract';

const runtime = vi.hoisted(() => {
  type Effect = { deps?: readonly unknown[]; cleanup?: () => void; run?: () => unknown };
  const slots: unknown[] = [];
  const effects: Effect[] = [];
  let cursor = 0;
  let effectCursor = 0;
  const changed = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !a || !b || a.length !== b.length || a.some((item, i) => !Object.is(item, b[i]));
  return {
    reset() {
      slots.length = 0;
      effects.length = 0;
    },
    render<T>(fn: () => T): T {
      cursor = 0;
      effectCursor = 0;
      const result = fn();
      const due = effects.filter((effect) => effect.run);
      for (const effect of due) effect.cleanup?.();
      for (const effect of due) {
        const cleanup = effect.run?.();
        effect.run = undefined;
        effect.cleanup =
          typeof cleanup === 'function'
            ? () => {
                cleanup();
              }
            : undefined;
      }
      return result;
    },
    unmount() {
      for (const effect of effects) effect.cleanup?.();
    },
    useState<S>(initial: S | (() => S)) {
      const index = cursor++;
      if (!(index in slots))
        slots[index] = typeof initial === 'function' ? (initial as () => S)() : initial;
      const set = (next: S | ((value: S) => S)) => {
        slots[index] =
          typeof next === 'function' ? (next as (value: S) => S)(slots[index] as S) : next;
      };
      return [slots[index] as S, set] as const;
    },
    useRef<R>(initial: R) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index] as { current: R };
    },
    useCallback<F>(fn: F, deps: readonly unknown[]): F {
      const index = cursor++;
      const previous = slots[index] as { fn: F; deps: readonly unknown[] } | undefined;
      if (previous && !changed(previous.deps, deps)) return previous.fn;
      slots[index] = { fn, deps };
      return fn;
    },
    useEffect(run: () => unknown, deps?: readonly unknown[]) {
      const index = effectCursor++;
      const prev = effects[index];
      if (prev && !changed(prev.deps, deps)) return;
      effects[index] = { deps, cleanup: prev?.cleanup, run };
    },
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof ReactModule>()),
  useState: runtime.useState,
  useRef: runtime.useRef,
  useCallback: runtime.useCallback,
  useEffect: runtime.useEffect,
}));

const invoke = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Set<(state: FleetState) => void>());
vi.mock('@renderer/api', () => ({
  api: {
    invoke,
    on: vi.fn((_channel: string, listener: (state: FleetState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  },
}));
const { FleetPanel } = await import('@renderer/components/FleetPanel');
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const peer = (status: FleetState['peers'][number]['status'], code?: string): FleetState => ({
  enabled: true,
  port: 43872,
  peers: [
    { id: 'machine-b', name: 'Build Mac', status, ...(code ? { verificationCode: code } : {}) },
  ],
});
const remote: FleetStatus = {
  projects: [{ id: 12, name: 'Service' }],
  shells: [{ projectId: 12, shellIndex: 2, agent: 'omp', state: 'blocked' }],
};

function nodes(node: ReactNode): ReactElement[] {
  if (!isValidElement(node)) return [];
  if (typeof node.type === 'function') {
    const rendered: unknown = Reflect.apply(node.type, undefined, [node.props]);
    return isValidElement(rendered) ? nodes(rendered) : [];
  }
  const children = (node.props as { children?: ReactNode }).children;
  return [node, ...(Array.isArray(children) ? children.flatMap(nodes) : nodes(children))];
}
function descendants(item: ReactElement | undefined): ReactElement[] {
  if (!item) return [];
  const props: unknown = item.props;
  if (!props || typeof props !== 'object' || !('children' in props)) return [];
  const children: unknown = props.children;
  if (Array.isArray(children))
    return children.flatMap((child: unknown) => (isValidElement(child) ? nodes(child) : []));
  return isValidElement(children) ? nodes(children) : [];
}
function attribute(item: ReactElement, name: string): string | undefined {
  const props: unknown = item.props;
  if (!props || typeof props !== 'object' || !(name in props)) return undefined;
  const value: unknown = (props as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}
function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (!isValidElement(node)) return '';
  return text((node.props as { children?: ReactNode }).children);
}
function mount(state: FleetState = { enabled: false, peers: [], port: 43872 }, loadError = false) {
  const onOpenSettings = vi.fn();
  let shown = remote;
  invoke.mockImplementation((channel: string) => {
    if (channel === 'fleet:get-state' && loadError)
      return Promise.reject(new Error('internal keychain diagnostics'));
    if (channel === 'fleet:get-state' || channel === 'fleet:set-enabled')
      return Promise.resolve(state);
    if (channel === 'fleet:status') return Promise.resolve(shown);
    if (channel === 'fleet:snapshot')
      return Promise.resolve({ output: '<script>alert(1)</script>\nready', alive: true });
    if (channel === 'fleet:launch') {
      shown = {
        ...shown,
        shells: [...shown.shells, { projectId: 12, shellIndex: 3, agent: null, state: 'idle' }],
      };
      return Promise.resolve({ shellIndex: 3 });
    }
    return Promise.resolve({ ok: true });
  });
  const draw = () => runtime.render(() => FleetPanel({ onOpenSettings }));
  const load = async () => {
    await flush();
    draw();
    await flush();
  };
  draw();
  return {
    onOpenSettings,
    draw,
    load,
    markup: () => renderToStaticMarkup(draw()),
    control(label: string) {
      const control = nodes(draw()).find(
        (item) =>
          item.type === 'button' &&
          text((item.props as { children?: ReactNode }).children) === label,
      );
      if (!control) throw new Error(`Missing button: ${label}`);
      return control.props as { disabled?: boolean; onClick: () => Promise<void> | void };
    },
    field(label: string) {
      const input = nodes(draw()).find(
        (item) =>
          (item.type === 'input' || item.type === 'textarea') &&
          (item.props as { 'aria-label'?: string })['aria-label'] === label,
      );
      if (!input) throw new Error(`Missing field: ${label}`);
      return input.props as { onChange: (event: { target: { value: string } }) => void };
    },
    submission() {
      const form = nodes(draw()).find((item) => item.type === 'form');
      if (!form) throw new Error('Missing remote input form');
      const props = form.props as { onSubmit: (event: { preventDefault: () => void }) => void };
      return props.onSubmit;
    },
    send() {
      const form = nodes(draw()).find((item) => item.type === 'form');
      if (!form) throw new Error('Missing remote input form');
      const props = form.props as { onSubmit: (event: { preventDefault: () => void }) => void };
      props.onSubmit({ preventDefault: () => undefined });
    },
    emit(next: FleetState) {
      for (const listener of listeners) listener(next);
    },
  };
}

beforeEach(() => {
  runtime.reset();
  listeners.clear();
  invoke.mockReset();
  vi.stubGlobal('window', globalThis);
});
afterEach(() => {
  runtime.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('FleetPanel', () => {
  it('starts off without enabling discovery and opens Fleet settings on request', async () => {
    const app = mount();
    await app.load();
    expect(app.markup()).toContain('Fleet is off');
    expect(invoke).not.toHaveBeenCalledWith('fleet:set-enabled', expect.anything());
    app.control('Open Fleet settings').onClick();
    expect(app.onOpenSettings).toHaveBeenCalledOnce();
  });

  it('shows a failed network listener separately from an empty LAN', async () => {
    const app = mount({
      enabled: true,
      peers: [],
      port: 43872,
      error: 'Fleet network unavailable. Check the local network and firewall.',
    });
    await app.load();
    expect(app.markup()).toContain('Fleet network unavailable');
    expect(app.markup()).not.toContain('Disable fleet');
  });

  it('shows discovery without shell controls; can initiate pairing', async () => {
    const app = mount(peer('discovered'));
    await app.load();
    expect(app.markup()).toContain('Build Mac');
    expect(app.markup()).toContain('Discovered');
    expect(app.markup()).not.toContain('Service');
    await app.control('Request link').onClick();
    expect(invoke).toHaveBeenCalledWith('fleet:pair', { peerId: 'machine-b' });
    expect(invoke).not.toHaveBeenCalledWith('fleet:status', expect.anything());
  });

  it('requires an explicit matching-code confirmation before approving either end', async () => {
    const app = mount(peer('pending', '123 456'));
    await app.load();
    expect(app.markup()).toContain('123 456');
    expect(app.control('Approve link').disabled).toBe(true);
    app.field('Matching code from both devices').onChange({ target: { value: 'bad code' } });
    expect(app.control('Approve link').disabled).toBe(true);
    app.field('Matching code from both devices').onChange({ target: { value: '123 456' } });
    expect(app.control('Approve link').disabled).toBe(false);
    await app.control('Approve link').onClick();
    expect(invoke).toHaveBeenCalledWith('fleet:approve', {
      peerId: 'machine-b',
      verificationCode: '123 456',
    });
    app.emit(peer('offline'));
    expect(app.markup()).not.toContain('123 456');
    expect(invoke).not.toHaveBeenCalledWith('fleet:status', expect.anything());
  });

  it('lists remote projects and shells only while linked, with escaped snapshot and remote-machine labels', async () => {
    const app = mount(peer('linked'));
    await app.load();
    expect(app.markup()).toContain('Service');
    expect(app.markup()).toContain('OMP needs your input');
    expect(app.markup()).toContain('Remote machine: Build Mac');
    app.control('View shell 3').onClick();
    app.draw();
    await flush();
    const html = app.markup();
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    app.field('Input to Build Mac shell 3').onChange({ target: { value: 'pwd\n' } });
    app.send();
    expect(invoke).toHaveBeenCalledWith('fleet:write', {
      peerId: 'machine-b',
      projectId: 12,
      shellIndex: 2,
      data: 'pwd\n',
    });
    await flush();
    app.control('Stop shell 3 on Build Mac').onClick();
    expect(invoke).toHaveBeenCalledWith('fleet:stop', {
      peerId: 'machine-b',
      projectId: 12,
      shellIndex: 2,
    });
  });

  it('keeps shell input disabled and explains a failed output snapshot', async () => {
    const app = mount(peer('linked'));
    await app.load();
    invoke.mockImplementation((channel: string) =>
      channel === 'fleet:snapshot'
        ? Promise.reject(new Error('terminal content secret'))
        : Promise.resolve(remote),
    );
    app.control('View shell 3').onClick();
    app.draw();
    await flush();
    const html = app.markup();
    expect(html).toContain('Could not read remote output');
    expect(html).toContain('Output unavailable.');
    expect(html).not.toContain('terminal content secret');
    expect(app.control('Send to Build Mac').disabled).toBe(true);
    app.send();
    expect(invoke).not.toHaveBeenCalledWith('fleet:write', expect.anything());
  });

  it('opens the launched shell on the named remote machine', async () => {
    const app = mount(peer('linked'));
    await app.load();
    app.control('Launch shell on Build Mac in Service').onClick();
    await flush();
    app.draw();
    await flush();
    expect(app.markup()).toContain('Remote shell 4 on Build Mac');
    expect(invoke).toHaveBeenCalledWith('fleet:snapshot', {
      peerId: 'machine-b',
      projectId: 12,
      shellIndex: 3,
    });
  });
  it('launches on a selected remote project and rejects a stale control after disconnect', async () => {
    const app = mount(peer('linked'));
    await app.load();
    const launch = app.control('Launch shell on Build Mac in Service').onClick;
    launch();
    expect(invoke).toHaveBeenCalledWith('fleet:launch', { peerId: 'machine-b', projectId: 12 });
    app.emit(peer('offline'));
    launch();
    expect(invoke.mock.calls.filter(([channel]) => channel === 'fleet:launch')).toHaveLength(1);
    expect(app.markup()).toContain('Offline');
    expect(app.markup()).not.toContain('Service');
    expect(app.markup()).not.toContain('Launch shell on Build Mac');
    expect(app.markup()).not.toContain('Input to Build Mac');
    expect(invoke).not.toHaveBeenCalledWith('fleet:write', expect.anything());
    await app.control('Revoke link').onClick();
    expect(invoke).toHaveBeenCalledWith('fleet:revoke', { peerId: 'machine-b' });
    app.emit({ enabled: true, peers: [], port: 43872 });
    expect(app.markup()).not.toContain('Build Mac');
    expect(app.markup()).not.toContain('Service');
  });

  it('refuses captured input submission after a peer goes offline', async () => {
    const app = mount(peer('linked'));
    await app.load();
    app.control('View shell 3').onClick();
    app.draw();
    await flush();
    app.field('Input to Build Mac shell 3').onChange({ target: { value: 'dangerous\n' } });
    const submit = app.submission();
    app.emit(peer('offline'));
    submit({ preventDefault: () => undefined });
    expect(invoke).not.toHaveBeenCalledWith('fleet:write', expect.anything());
  });

  it('refuses captured launch controls when fleet is disabled', async () => {
    const app = mount(peer('linked'));
    await app.load();
    const launch = app.control('Launch shell on Build Mac in Service').onClick;
    app.emit({ enabled: false, peers: peer('linked').peers, port: 43872 });
    launch();
    expect(app.markup()).toContain('Fleet is off');
    expect(invoke).not.toHaveBeenCalledWith('fleet:launch', expect.anything());
  });

  it('shows a status reply slower than multiple polling intervals without piling up requests', async () => {
    vi.useFakeTimers();
    let answer: ((status: FleetStatus) => void) | undefined;
    const app = mount(peer('linked'));
    invoke.mockImplementation((channel: string) =>
      channel === 'fleet:status'
        ? new Promise<FleetStatus>((resolve) => {
            answer = resolve;
          })
        : Promise.resolve(peer('linked')),
    );
    await app.load();
    vi.advanceTimersByTime(9_000);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'fleet:status')).toHaveLength(1);
    answer?.(remote);
    await flush();
    expect(app.markup()).toContain('Service');
    vi.advanceTimersByTime(3_000);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'fleet:status')).toHaveLength(2);
  });

  it('lets explicit refresh replace a slow status poll without accepting the old answer', async () => {
    vi.useFakeTimers();
    const answers: Array<(status: FleetStatus) => void> = [];
    const app = mount(peer('linked'));
    invoke.mockImplementation((channel: string) =>
      channel === 'fleet:status'
        ? new Promise<FleetStatus>((resolve) => {
            answers.push(resolve);
          })
        : Promise.resolve(peer('linked')),
    );
    await app.load();
    app.control('Refresh remote status').onClick();
    expect(answers).toHaveLength(2);
    answers[1]?.({ projects: [{ id: 12, name: 'Fresh' }], shells: [] });
    await flush();
    answers[0]?.(remote);
    await flush();
    expect(app.markup()).toContain('Fresh');
    expect(app.markup()).not.toContain('Service');
    vi.advanceTimersByTime(3_000);
    expect(answers).toHaveLength(3);
  });

  it('serializes shell polls so an older live snapshot cannot overtake an exited one', async () => {
    vi.useFakeTimers();
    const answers: Array<(snapshot: { output: string; alive: boolean }) => void> = [];
    const app = mount(peer('linked'));
    await app.load();
    invoke.mockImplementation((channel: string) =>
      channel === 'fleet:snapshot'
        ? new Promise<{ output: string; alive: boolean }>((resolve) => {
            answers.push(resolve);
          })
        : Promise.resolve(remote),
    );
    app.control('View shell 3').onClick();
    app.draw();
    vi.advanceTimersByTime(4_500);
    expect(answers).toHaveLength(1);
    answers[0]?.({ output: 'older live output', alive: true });
    await flush();
    app.field('Input to Build Mac shell 3').onChange({ target: { value: 'pwd' } });
    vi.advanceTimersByTime(1_500);
    expect(answers).toHaveLength(2);
    answers[1]?.({ output: 'shell exited', alive: false });
    await flush();
    expect(app.markup()).toContain('shell exited');
    expect(app.markup()).not.toContain('older live output');
    expect(app.markup()).toContain('This remote shell has exited');
    expect(app.control('Send to Build Mac').disabled).toBe(true);
    app.send();
    expect(invoke).not.toHaveBeenCalledWith('fleet:write', expect.anything());
  });

  it('ignores a previous peer snapshot after switching to an exited shell on another peer', async () => {
    vi.useFakeTimers();
    const answers: Array<{
      peerId: string;
      resolve: (snapshot: { output: string; alive: boolean }) => void;
    }> = [];
    const both: FleetState = {
      enabled: true,
      port: 43872,
      peers: [...peer('linked').peers, { id: 'machine-c', name: 'Other Mac', status: 'linked' }],
    };
    const app = mount(both);
    await app.load();
    invoke.mockImplementation((channel: string, args: { peerId?: string }) =>
      channel === 'fleet:snapshot'
        ? new Promise<{ output: string; alive: boolean }>((resolve) => {
            answers.push({ peerId: args.peerId ?? '', resolve });
          })
        : Promise.resolve(channel === 'fleet:status' ? remote : both),
    );
    app.control('View shell 3').onClick();
    app.draw();
    expect(answers.map((answer) => answer.peerId)).toEqual(['machine-b']);
    app.control('View Other Mac').onClick();
    app.draw();
    await flush();
    app.control('View shell 3').onClick();
    app.draw();
    expect(answers.map((answer) => answer.peerId)).toEqual(['machine-b', 'machine-c']);
    answers[1]?.resolve({ output: 'other shell exited', alive: false });
    await flush();
    answers[0]?.resolve({ output: 'old live output', alive: true });
    await flush();
    expect(app.markup()).toContain('other shell exited');
    expect(app.markup()).not.toContain('old live output');
    expect(app.control('Send to Other Mac').disabled).toBe(true);
    app.send();
    expect(invoke).not.toHaveBeenCalledWith('fleet:write', expect.anything());
  });

  it('does not let an old linked peer status replace the newly selected peer', async () => {
    const answers: Array<{
      peerId: string;
      resolve: (status: FleetStatus) => void;
    }> = [];
    const both: FleetState = {
      enabled: true,
      port: 43872,
      peers: [...peer('linked').peers, { id: 'machine-c', name: 'Other Mac', status: 'linked' }],
    };
    const app = mount(both);
    invoke.mockImplementation((channel: string, args: { peerId?: string }) =>
      channel === 'fleet:status'
        ? new Promise<FleetStatus>((resolve) => {
            answers.push({ peerId: args.peerId ?? '', resolve });
          })
        : Promise.resolve(both),
    );
    await app.load();
    app.control('View Other Mac').onClick();
    app.draw();
    expect(answers.map((answer) => answer.peerId)).toEqual(['machine-b', 'machine-c']);
    answers[1]?.resolve({ projects: [{ id: 12, name: 'Other project' }], shells: [] });
    await flush();
    answers[0]?.resolve(remote);
    await flush();
    expect(app.markup()).toContain('Other project');
    expect(app.markup()).not.toContain('Service');
  });

  it('does not allow a captured old-peer refresh to displace a pending new-peer status', async () => {
    const answers: Array<{ peerId: string; resolve: (status: FleetStatus) => void }> = [];
    const both: FleetState = {
      enabled: true,
      port: 43872,
      peers: [...peer('linked').peers, { id: 'machine-c', name: 'Other Mac', status: 'linked' }],
    };
    const app = mount(both);
    invoke.mockImplementation((channel: string, args: { peerId?: string }) =>
      channel === 'fleet:status'
        ? new Promise<FleetStatus>((resolve) => {
            answers.push({ peerId: args.peerId ?? '', resolve });
          })
        : Promise.resolve(both),
    );
    await app.load();
    const oldRefresh = app.control('Refresh remote status').onClick;
    app.control('View Other Mac').onClick();
    app.draw();
    oldRefresh();
    expect(answers.map((answer) => answer.peerId)).toEqual(['machine-b', 'machine-c']);
    answers[1]?.resolve({ projects: [{ id: 12, name: 'Other project' }], shells: [] });
    await flush();
    expect(app.markup()).toContain('Other project');
  });

  it('discards a pending snapshot after the peer goes offline and is linked again', async () => {
    vi.useFakeTimers();
    const answers: Array<(snapshot: { output: string; alive: boolean }) => void> = [];
    const app = mount(peer('linked'));
    await app.load();
    invoke.mockImplementation((channel: string) =>
      channel === 'fleet:snapshot'
        ? new Promise<{ output: string; alive: boolean }>((resolve) => {
            answers.push(resolve);
          })
        : Promise.resolve(channel === 'fleet:status' ? remote : peer('linked')),
    );
    app.control('View shell 3').onClick();
    app.draw();
    app.emit(peer('offline'));
    app.draw();
    answers[0]?.({ output: 'stale live shell', alive: true });
    await flush();
    app.emit(peer('linked'));
    app.draw();
    await flush();
    expect(app.markup()).not.toContain('stale live shell');
    app.control('View shell 3').onClick();
    app.draw();
    expect(answers).toHaveLength(2);
    expect(app.control('Send to Build Mac').disabled).toBe(true);
  });

  it('ignores late status from a disconnected peer', async () => {
    let answer: ((status: FleetStatus) => void) | undefined;
    const app = mount(peer('linked'));
    invoke.mockImplementation((channel: string) =>
      channel === 'fleet:status'
        ? new Promise<FleetStatus>((resolve) => {
            answer = resolve;
          })
        : Promise.resolve(peer('linked')),
    );
    await app.load();
    app.emit(peer('offline'));
    answer?.(remote);
    await flush();
    expect(app.markup()).not.toContain('Service');
  });

  it('explains failed status refresh without presenting stale shells as live', async () => {
    const app = mount(peer('linked'));
    await app.load();
    invoke.mockImplementation((channel: string) =>
      channel === 'fleet:status'
        ? Promise.reject(new Error('private diagnostics'))
        : Promise.resolve({ ok: true }),
    );
    app.control('Refresh remote status').onClick();
    await flush();
    expect(app.markup()).toContain('Could not load remote status');
    expect(app.markup()).not.toContain('Service');
    expect(app.markup()).not.toContain('private diagnostics');
  });
  it('shows a safe retry when discovery initialization fails', async () => {
    const app = mount(undefined, true);
    await flush();
    expect(app.markup()).toContain('Could not load fleet');
    expect(app.markup()).toContain('Retry');
    expect(app.markup()).not.toContain('Loading fleet…');
    expect(app.markup()).not.toContain('internal keychain diagnostics');
  });
  it('cancels pending requests and reports pairing failure without leaking diagnostics', async () => {
    const app = mount(peer('pending', '123 456'));
    await app.load();
    app.control('Cancel request').onClick();
    expect(invoke).toHaveBeenCalledWith('fleet:revoke', { peerId: 'machine-b' });
    await flush();
    invoke.mockRejectedValueOnce(new Error('private peer secret'));
    app.field('Matching code from both devices').onChange({ target: { value: '123 456' } });
    app.control('Approve link').onClick();
    await flush();
    expect(app.markup()).toContain('Could not approve link');
    expect(app.markup()).not.toContain('private peer secret');
  });
  it('does not overwrite a new fleet event with an older initial state response', async () => {
    const app = mount();
    app.emit(peer('linked'));
    await app.load();
    expect(app.markup()).toContain('Build Mac');
    expect(app.markup()).toContain('Service');
  });

  describe('port and identity recovery', () => {
    function intercept(handler: (channel: string, request: unknown) => unknown) {
      const base = invoke.getMockImplementation();
      invoke.mockImplementation((channel: string, request: unknown) => {
        const result = handler(channel, request);
        return result === undefined ? base?.(channel, request) : result;
      });
    }
    const field = (app: ReturnType<typeof mount>) => app.field('Fleet port');

    it('shows the current port with the firewall rules for that port', async () => {
      const app = mount({ enabled: false, peers: [], port: 45123 });
      await app.load();
      const markup = app.markup();
      expect(markup).toContain('sudo ufw allow 43871/udp');
      expect(markup).toContain('sudo ufw allow 45123/tcp');
      expect(markup).not.toContain('43872/tcp');
      expect(field(app)).toMatchObject({ value: '45123' });
    });

    it('saves the typed port through fleet:set-port and shows the returned port', async () => {
      const app = mount();
      await app.load();
      intercept((channel, request) =>
        channel === 'fleet:set-port'
          ? Promise.resolve({ enabled: false, peers: [], port: (request as { port: number }).port })
          : undefined,
      );
      field(app).onChange({ target: { value: '45000' } });
      await app.control('Save port').onClick();
      await flush();
      expect(invoke).toHaveBeenCalledWith('fleet:set-port', { port: 45000 });
      expect(app.markup()).toContain('sudo ufw allow 45000/tcp');
    });

    it('shows the main-side rejection message and keeps the old port', async () => {
      const app = mount();
      await app.load();
      intercept((channel) =>
        channel === 'fleet:set-port'
          ? Promise.reject(
              new Error(
                "Error invoking remote method 'fleet:set-port': Error: Fleet port 1000 is already in use",
              ),
            )
          : undefined,
      );
      field(app).onChange({ target: { value: '1000' } });
      await app.control('Save port').onClick();
      await flush();
      expect(app.markup()).toContain('Fleet port 1000 is already in use');
      expect(app.markup()).not.toContain('Error invoking remote method');
      expect(app.markup()).toContain('sudo ufw allow 43872/tcp');
    });

    it('disables Save while the port field is empty or unchanged', async () => {
      const app = mount();
      await app.load();
      expect(app.control('Save port').disabled).toBe(true);
      field(app).onChange({ target: { value: '' } });
      expect(app.control('Save port').disabled).toBe(true);
      field(app).onChange({ target: { value: '43873' } });
      expect(app.control('Save port').disabled).toBe(false);
    });

    it('offers Reset identity only in the recovery state', async () => {
      const healthy = mount();
      await healthy.load();
      expect(healthy.markup()).not.toContain('Reset identity');
      runtime.unmount();
      runtime.reset();
      const stuck = mount({
        enabled: false,
        peers: [],
        port: 43872,
        recovery: 'reset-identity',
        error: 'Fleet identity in the credential store is unreadable.',
      });
      await stuck.load();
      expect(stuck.markup()).toContain('unreadable');
      expect(stuck.markup()).toContain('Reset identity');
    });

    it('arms on first click and only resets on the second', async () => {
      const app = mount({ enabled: false, peers: [], port: 43872, recovery: 'reset-identity' });
      await app.load();
      intercept((channel) =>
        channel === 'fleet:reset-identity'
          ? Promise.resolve({ enabled: false, peers: [], port: 43872 })
          : undefined,
      );
      await app.control('Reset identity').onClick();
      await flush();
      expect(invoke).not.toHaveBeenCalledWith('fleet:reset-identity', undefined);
      expect(app.markup()).toContain('Confirm reset — paired devices must pair again');
      await app.control('Confirm reset — paired devices must pair again').onClick();
      await flush();
      expect(invoke).toHaveBeenCalledWith('fleet:reset-identity', undefined);
      expect(app.markup()).not.toContain('Reset identity');
      expect(app.markup()).not.toContain('Confirm reset');
    });

    it('disarms when recovery ends elsewhere so a stale confirm cannot fire later', async () => {
      const app = mount({ enabled: false, peers: [], port: 43872, recovery: 'reset-identity' });
      await app.load();
      await app.control('Reset identity').onClick();
      await flush();
      app.emit({ enabled: false, peers: [], port: 43872 });
      app.emit({ enabled: false, peers: [], port: 43872, recovery: 'reset-identity' });
      expect(app.markup()).toContain('Reset identity');
      expect(app.markup()).not.toContain('Confirm reset');
    });
  });

  it('groups a linked machine heading with its projects in the same machine entry', async () => {
    const app = mount(peer('linked'));
    await app.load();
    const machine = nodes(app.draw()).find((item) => {
      if (item.type !== 'li') return false;
      const children = descendants(item);
      return children.some(
        (child) =>
          typeof child.type === 'string' &&
          /^h[1-6]$/.test(child.type) &&
          text(child) === 'Build Mac',
      );
    });
    expect(machine).toBeDefined();
    const projects = descendants(machine).filter((item) => item.type === 'li');
    expect(
      projects.some((project) =>
        descendants(project).some(
          (child) =>
            typeof child.type === 'string' &&
            /^h[1-6]$/.test(child.type) &&
            text(child) === 'Service',
        ),
      ),
    ).toBe(true);
  });

  it('selects a nested project context without fetching every linked machine', async () => {
    const both: FleetState = {
      enabled: true,
      port: 43872,
      peers: [...peer('linked').peers, { id: 'machine-c', name: 'Other Mac', status: 'linked' }],
    };
    const app = mount(both);
    invoke.mockImplementation((channel: string) =>
      Promise.resolve(channel === 'fleet:status'
        ? { ...remote, projects: [...remote.projects, { id: 34, name: 'Second folder' }] }
        : channel === 'fleet:launch' ? { shellIndex: 0 } : both));
    await app.load();
    expect(invoke.mock.calls.filter(([channel]) => channel === 'fleet:status')).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith('fleet:status', { peerId: 'machine-b' });
    const staleLaunch = app.control('Launch shell on Build Mac in Service').onClick;
    app.control('Second folder').onClick();
    expect(app.markup()).toContain('Launch shell on Build Mac in Second folder');
    expect(app.markup()).not.toContain('Launch shell on Build Mac in Service');
    staleLaunch();
    expect(invoke).not.toHaveBeenCalledWith('fleet:launch', expect.anything());
    app.control('Launch shell on Build Mac in Second folder').onClick();
    expect(invoke).toHaveBeenCalledWith('fleet:launch', { peerId: 'machine-b', projectId: 34 });
  });

  it('shows a launched shell and its output in a dedicated remote workspace', async () => {
    const app = mount(peer('linked'));
    await app.load();
    await app.control('Launch shell on Build Mac in Service').onClick();
    await flush();
    app.draw();
    await flush();
    const workspace = nodes(app.draw()).find(
      (item) =>
        item.type === 'section' &&
        /remote shell workspace/i.test(attribute(item, 'aria-label') ?? ''),
    );
    expect(workspace).toBeDefined();
    const content = descendants(workspace);
    expect(
      content.some(
        (item) =>
          typeof item.type === 'string' &&
          /^h[1-6]$/.test(item.type) &&
          text(item) === 'Remote shell 4 on Build Mac',
      ),
    ).toBe(true);
    expect(
      content.some(
        (item) =>
          item.type === 'pre' &&
          attribute(item, 'role') === 'log' &&
          text(item).includes('ready'),
      ),
    ).toBe(true);
    expect(content.some((item) => item.type === 'button' && text(item).includes('Launch shell'))).toBe(true);
  });

  it('reports failed launches beside the remote workspace rather than above the machine list', async () => {
    const app = mount(peer('linked'));
    await app.load();
    invoke.mockImplementation((channel: string) =>
      channel === 'fleet:launch'
        ? Promise.reject(new Error('private remote failure'))
        : Promise.resolve(channel === 'fleet:status' ? remote : peer('linked')),
    );
    await app.control('Launch shell on Build Mac in Service').onClick();
    const workspace = nodes(app.draw()).find(
      (item) =>
        item.type === 'section' &&
        /remote shell workspace/i.test(attribute(item, 'aria-label') ?? ''),
    );
    expect(workspace).toBeDefined();
    expect(
      descendants(workspace).some(
        (item) =>
          attribute(item, 'role') === 'alert' &&
          text(item).includes('Could not launch remote shell'),
      ),
    ).toBe(true);
    expect(
      descendants(workspace).some(
        (item) => item.type === 'button' && text(item).includes('Launch shell'),
      ),
    ).toBe(true);
    expect(app.markup()).not.toContain('private remote failure');
  });

  it('directs disabled Fleet to Settings without offering a duplicate enablement control', async () => {
    const app = mount();
    await app.load();
    const buttons = nodes(app.draw())
      .filter((item) => item.type === 'button')
      .map((item) => text(item));
    expect(buttons).not.toContain('Enable fleet');
    expect(buttons).not.toContain('Disable fleet');
    expect(buttons.some((label) => /open fleet settings/i.test(label))).toBe(true);
  });

  it('keeps pairing actions but not the Settings enablement switch in enabled Fleet', async () => {
    const app = mount(peer('discovered'));
    await app.load();
    const buttons = nodes(app.draw())
      .filter((item) => item.type === 'button')
      .map((item) => text(item));
    expect(buttons).toContain('Request link');
    expect(buttons).not.toContain('Enable fleet');
    expect(buttons).not.toContain('Disable fleet');
  });
});
