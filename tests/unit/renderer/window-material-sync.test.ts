import { describe, it, expect, vi } from 'vitest';
import {
  applyRenderToRoot,
  bootstrapFromQuery,
  installWindowMaterialSync,
  createLatestWinsSender,
  type MaterialSyncApi,
  type StyleTarget,
} from '@renderer/window-material-sync';
import type { WindowMaterialRender } from '@shared/window-material';

function fakeTarget(): StyleTarget & { props: Map<string, string>; calls: number } {
  const props = new Map<string, string>();
  const t = {
    props,
    calls: 0,
    style: {
      setProperty(name: string, value: string) {
        t.calls += 1;
        props.set(name, value);
      },
    },
  };
  return t;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type Listener = (p: { key: string }) => void;

function fakeApi(renders: Array<Promise<WindowMaterialRender>>) {
  const listeners = new Set<Listener>();
  const invoke = vi.fn(() => {
    const next = renders.shift();
    if (!next) throw new Error('unexpected invoke');
    return next;
  });
  const api: MaterialSyncApi & { emit(key: string): void; listenerCount(): number } = {
    invoke,
    on(_channel: 'settings:changed', cb: Listener) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    emit(key: string) { for (const l of [...listeners]) l({ key }); },
    listenerCount() { return listeners.size; },
  };
  return { api, invoke };
}

function manualScheduler() {
  const queue: Array<() => void> = [];
  const schedule = vi.fn((cb: () => void) => { queue.push(cb); });
  const flush = () => { while (queue.length) queue.shift()?.(); };
  return { schedule, flush, pending: () => queue.length };
}

const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

describe('applyRenderToRoot', () => {
  it('sets exactly the three material variables, formatted from numbers', () => {
    const t = fakeTarget();
    applyRenderToRoot(t, { surfaceAlpha: 0.7, blurPx: 30, saturatePct: 150 });
    expect(Object.fromEntries(t.props)).toEqual({
      '--material-alpha': '0.7',
      '--material-blur': '30px',
      '--material-saturate': '150%',
    });
    expect(t.calls).toBe(3);
  });

  it('formats boundary values without units drifting', () => {
    const t = fakeTarget();
    applyRenderToRoot(t, { surfaceAlpha: 1, blurPx: 0, saturatePct: 100 });
    expect(t.props.get('--material-alpha')).toBe('1');
    expect(t.props.get('--material-blur')).toBe('0px');
    expect(t.props.get('--material-saturate')).toBe('100%');
  });

  it('never writes a non-finite value into CSS', () => {
    const t = fakeTarget();
    applyRenderToRoot(t, { surfaceAlpha: Number.NaN, blurPx: Number.POSITIVE_INFINITY, saturatePct: 150 });
    expect(t.props.has('--material-alpha')).toBe(false);
    expect(t.props.has('--material-blur')).toBe(false);
    expect(t.props.get('--material-saturate')).toBe('150%');
  });
});

describe('bootstrapFromQuery', () => {
  it('sets nothing for a malformed material query, so the CSS defaults apply', () => {
    const t = fakeTarget();
    bootstrapFromQuery(t, '?material=garbage');
    expect(t.calls).toBe(0);
  });

  it('sets nothing when the query has no material parameter', () => {
    const t = fakeTarget();
    bootstrapFromQuery(t, '?popout=1&projectId=3');
    expect(t.calls).toBe(0);
  });

  it('applies a valid material query alongside other parameters', () => {
    const t = fakeTarget();
    bootstrapFromQuery(t, '?popout=1&material=0.7,30,150');
    expect(Object.fromEntries(t.props)).toEqual({
      '--material-alpha': '0.7',
      '--material-blur': '30px',
      '--material-saturate': '150%',
    });
  });
});

describe('installWindowMaterialSync', () => {
  const render: WindowMaterialRender = { surfaceAlpha: 0.8, blurPx: 12, saturatePct: 140 };

  it('coalesces the change events of one update into a single render fetch', async () => {
    const { api, invoke } = fakeApi([Promise.resolve(render)]);
    const s = manualScheduler();
    const t = fakeTarget();
    installWindowMaterialSync(api, t, s.schedule);

    api.emit('window_opacity');
    api.emit('window_backdrop_blur');
    api.emit('window_backdrop_saturation');
    expect(s.schedule).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();

    s.flush();
    await flushMicrotasks();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('app:get-window-render', undefined);
    expect(t.props.get('--material-blur')).toBe('12px');
    expect(t.props.get('--material-alpha')).toBe('0.8');
  });

  it('ignores changes to non-material settings', () => {
    const { api, invoke } = fakeApi([]);
    const s = manualScheduler();
    installWindowMaterialSync(api, fakeTarget(), s.schedule);
    api.emit('theme');
    api.emit('keep_alive_cap');
    expect(s.schedule).not.toHaveBeenCalled();
    s.flush();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('schedules again for a change after the previous frame ran', async () => {
    const { api, invoke } = fakeApi([Promise.resolve(render), Promise.resolve({ ...render, blurPx: 5 })]);
    const s = manualScheduler();
    const t = fakeTarget();
    installWindowMaterialSync(api, t, s.schedule);
    api.emit('window_opacity');
    s.flush();
    await flushMicrotasks();
    api.emit('window_backdrop_blur');
    s.flush();
    await flushMicrotasks();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(t.props.get('--material-blur')).toBe('5px');
  });

  it('never lets an older response overwrite a newer one', async () => {
    const older = deferred<WindowMaterialRender>();
    const newer = deferred<WindowMaterialRender>();
    const { api } = fakeApi([older.promise, newer.promise]);
    const s = manualScheduler();
    const t = fakeTarget();
    installWindowMaterialSync(api, t, s.schedule);
    api.emit('window_opacity');
    s.flush();
    api.emit('window_opacity');
    s.flush();
    newer.resolve({ ...render, blurPx: 33 });
    await flushMicrotasks();
    older.resolve({ ...render, blurPx: 1 });
    await flushMicrotasks();
    expect(t.props.get('--material-blur')).toBe('33px');
  });

  it('keeps the current values and logs when the fetch fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { api } = fakeApi([Promise.reject(new Error('boom'))]);
    const s = manualScheduler();
    const t = fakeTarget();
    installWindowMaterialSync(api, t, s.schedule);
    api.emit('window_opacity');
    s.flush();
    await flushMicrotasks();
    expect(t.calls).toBe(0);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('returns an unsubscribe that detaches the listener and drops a scheduled fetch', () => {
    const { api, invoke } = fakeApi([Promise.resolve(render)]);
    const s = manualScheduler();
    const off = installWindowMaterialSync(api, fakeTarget(), s.schedule);
    expect(api.listenerCount()).toBe(1);
    api.emit('window_opacity');
    off();
    expect(api.listenerCount()).toBe(0);
    s.flush();
    api.emit('window_opacity');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('createLatestWinsSender', () => {
  it('keeps one request in flight and sends only the latest value when it settles', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const queue = [first.promise, second.promise];
    const send = vi.fn(() => queue.shift() ?? Promise.reject(new Error('unexpected send')));
    const push = createLatestWinsSender(send, () => undefined, () => undefined);

    push(1);
    push(2);
    push(3);
    push(4);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(1);

    first.resolve('r1');
    await flushMicrotasks();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(4);

    second.resolve('r4');
    await flushMicrotasks();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('reports only the result of the latest value, not superseded ones', async () => {
    const first = deferred<string>();
    const queue = [first.promise, Promise.resolve('r2')];
    const onResult = vi.fn();
    const push = createLatestWinsSender(() => queue.shift() ?? Promise.reject(new Error('x')), onResult, () => undefined);
    push(1);
    push(2);
    first.resolve('r1');
    await flushMicrotasks();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith('r2');
  });

  it('sends immediately again once idle', async () => {
    const send = vi.fn((v: number) => Promise.resolve(`r${v}`));
    const onResult = vi.fn();
    const push = createLatestWinsSender(send, onResult, () => undefined);
    push(1);
    await flushMicrotasks();
    push(2);
    expect(send).toHaveBeenCalledTimes(2);
    await flushMicrotasks();
    expect(onResult.mock.calls).toEqual([['r1'], ['r2']]);
  });

  it('reports a failure and does not wedge the queue', async () => {
    const onError = vi.fn();
    const onResult = vi.fn();
    const queue = [Promise.reject(new Error('nope')), Promise.resolve('ok')];
    const send = vi.fn(() => queue.shift() ?? Promise.reject(new Error('x')));
    const push = createLatestWinsSender(send, onResult, onError);
    push(1);
    await flushMicrotasks();
    expect(onError).toHaveBeenCalledTimes(1);
    push(2);
    await flushMicrotasks();
    expect(send).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledWith('ok');
  });

  it('still sends the pending value when the in-flight request fails', async () => {
    const first = deferred<string>();
    const queue = [first.promise, Promise.resolve('r2')];
    const onError = vi.fn();
    const onResult = vi.fn();
    const send = vi.fn(() => queue.shift() ?? Promise.reject(new Error('x')));
    const push = createLatestWinsSender(send, onResult, onError);
    push(1);
    push(2);
    first.reject(new Error('down'));
    await flushMicrotasks();
    expect(send).toHaveBeenLastCalledWith(2);
    expect(onError).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith('r2');
  });
});
