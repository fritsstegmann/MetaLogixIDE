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
function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (!isValidElement(node)) return '';
  return text((node.props as { children?: ReactNode }).children);
}
function mount(state: FleetState = { enabled: false, peers: [] }, loadError = false) {
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
  const draw = () => runtime.render(() => FleetPanel());
  const load = async () => {
    await flush();
    draw();
    await flush();
  };
  draw();
  return {
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
  it('starts off and enables discovery only on explicit user action', async () => {
    const app = mount();
    await app.load();
    expect(app.markup()).toContain('Fleet is off');
    expect(invoke).not.toHaveBeenCalledWith('fleet:set-enabled', expect.anything());
    await app.control('Enable fleet').onClick();
    expect(invoke).toHaveBeenCalledWith('fleet:set-enabled', { enabled: true });
  });

  it('shows a failed network listener separately from an empty LAN', async () => {
    const app = mount({
      enabled: true,
      peers: [],
      error: 'Fleet network unavailable. Check the local network and firewall.',
    });
    await app.load();
    expect(app.markup()).toContain('Fleet network unavailable');
    expect(app.markup()).toContain('Disable fleet');
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
    app.emit({ enabled: true, peers: [] });
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
    app.emit({ enabled: false, peers: peer('linked').peers });
    launch();
    expect(app.markup()).toContain('Fleet is off');
    expect(invoke).not.toHaveBeenCalledWith('fleet:launch', expect.anything());
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
});
