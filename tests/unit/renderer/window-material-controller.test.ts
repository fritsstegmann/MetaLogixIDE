import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createWindowMaterialController,
  errorText,
  type WindowMaterialIo,
  type WindowMaterialState,
} from '@renderer/window-material-sync';
import { DEFAULT_WINDOW_MATERIAL, type WindowMaterial } from '@shared/window-material';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup(stored: Record<string, unknown>, save: WindowMaterialIo['save'] = (m) => Promise.resolve(m)) {
  const states: WindowMaterialState[] = [];
  const io: WindowMaterialIo = {
    read: vi.fn((key: string) => (key in stored ? Promise.resolve(stored[key]) : Promise.reject(new Error(`no ${key}`)))),
    save: vi.fn(save),
  };
  const ctl = createWindowMaterialController(io, (s) => states.push(s));
  return { io, ctl, states, last: () => states.at(-1) };
}

const STORED = { window_opacity: 70, window_backdrop_blur: 12, window_backdrop_saturation: 150 };

afterEach(() => { vi.restoreAllMocks(); });

describe('createWindowMaterialController load', () => {
  it('reads the three material keys and reports them as loaded', async () => {
    const { io, ctl, last } = setup(STORED);
    ctl.load();
    await flush();
    expect(vi.mocked(io.read).mock.calls.map(([k]) => k).sort()).toEqual(
      ['window_backdrop_blur', 'window_backdrop_saturation', 'window_opacity'],
    );
    expect(last()).toEqual({ material: { opacity: 70, blur: 12, saturation: 150 }, loaded: true, error: null });
  });

  it('falls back to the default for each non-number or non-finite stored value', async () => {
    const { ctl, last } = setup({ window_opacity: '70', window_backdrop_blur: Number.NaN, window_backdrop_saturation: 150 });
    ctl.load();
    await flush();
    expect(last()?.material).toEqual({ opacity: DEFAULT_WINDOW_MATERIAL.opacity, blur: DEFAULT_WINDOW_MATERIAL.blur, saturation: 150 });
  });

  it('reports a failed load as display text, keeps defaults and unlocks the controls', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ctl, last } = setup({ window_opacity: 70 });
    ctl.load();
    await flush();
    expect(last()).toEqual({ material: DEFAULT_WINDOW_MATERIAL, loaded: true, error: 'no window_backdrop_blur' });
    expect(err).toHaveBeenCalled();
  });

  it('ignores the outcome of a cancelled load, success or failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ok = setup(STORED);
    ok.ctl.load()();
    const bad = setup({});
    bad.ctl.load()();
    await flush();
    expect(ok.states).toEqual([]);
    expect(bad.states).toEqual([]);
  });
});

describe('createWindowMaterialController writes', () => {
  it('applies a change optimistically and sends the full material', async () => {
    const pending = deferred<WindowMaterial>();
    const { io, ctl, last } = setup(STORED, () => pending.promise);
    ctl.load();
    await flush();
    ctl.change('blur', 30);
    expect(last()?.material).toEqual({ opacity: 70, blur: 30, saturation: 150 });
    expect(io.save).toHaveBeenCalledWith({ opacity: 70, blur: 30, saturation: 150 });
  });

  it('keeps earlier changes when a later field changes while a save is in flight', async () => {
    const first = deferred<WindowMaterial>();
    const queue = [first.promise];
    const { io, ctl } = setup(STORED, (m) => queue.shift() ?? Promise.resolve(m));
    ctl.load();
    await flush();
    ctl.change('blur', 30);
    ctl.change('opacity', 50);
    first.resolve({ opacity: 70, blur: 30, saturation: 150 });
    await flush();
    expect(io.save).toHaveBeenLastCalledWith({ opacity: 50, blur: 30, saturation: 150 });
  });

  it('replaces local state with the normalised response and clears a previous error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const replies = [
      () => Promise.reject(new Error('down')),
      () => Promise.resolve({ opacity: 70, blur: 40, saturation: 150 }),
    ];
    const { ctl, last } = setup(STORED, () => replies.shift()?.() ?? Promise.reject(new Error('x')));
    ctl.load();
    await flush();
    ctl.change('blur', 39);
    await flush();
    expect(last()?.error).toBe('down');
    ctl.change('blur', 55);
    await flush();
    expect(last()).toEqual({ material: { opacity: 70, blur: 40, saturation: 150 }, loaded: true, error: null });
  });

  it('reports a failed save as display text and logs it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ctl, last } = setup(STORED, () => Promise.reject(new Error('disk full')));
    ctl.load();
    await flush();
    ctl.change('saturation', 120);
    await flush();
    expect(last()).toEqual({ material: { opacity: 70, blur: 12, saturation: 120 }, loaded: true, error: 'disk full' });
    expect(err).toHaveBeenCalledWith('window material save failed', expect.any(Error));
  });

  it('reset sends and shows the defaults', async () => {
    const { io, ctl, last } = setup(STORED);
    ctl.load();
    await flush();
    ctl.reset();
    expect(io.save).toHaveBeenCalledWith(DEFAULT_WINDOW_MATERIAL);
    expect(last()?.material).toEqual(DEFAULT_WINDOW_MATERIAL);
  });
});

describe('errorText', () => {
  it('strips the Error prefix and stringifies non-errors', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('plain')).toBe('plain');
    expect(errorText(42)).toBe('42');
  });
});
