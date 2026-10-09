/** Contract tests for the per-window terminal font weight store: load with default and invalid fallback, optimistic set, refresh ordering, cross-window sync and failure revert. */
import { describe, expect, it, vi } from 'vitest';
import { FONT_COPY } from '@renderer/fonts/font-contract';
import {
  createTerminalFontWeightStore,
  type TerminalFontWeightPorts,
  type TerminalFontWeightSnapshot,
} from '@renderer/fonts/terminal-font-weight-store';
import type { TerminalFontWeight } from '@shared/terminal-font-weight';

const KEY = 'terminal_font_weight';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface Harness {
  readonly ports: TerminalFontWeightPorts;
  readonly loadStored: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
  readonly save: ReturnType<typeof vi.fn<(value: TerminalFontWeight) => Promise<unknown>>>;
  readonly notifySaveFailed: ReturnType<typeof vi.fn<(message: string) => void>>;
  readonly reportError: ReturnType<typeof vi.fn<(context: string, error: unknown) => void>>;
  emitChanged(key: string): void;
  listenerCount(): number;
}

function harness(stored: unknown): Harness {
  let current: unknown = stored;
  const listeners = new Set<(key: string) => void>();
  const loadStored = vi.fn(async (): Promise<unknown> => current);
  const save = vi.fn(async (value: TerminalFontWeight): Promise<unknown> => {
    current = value;
    return { value, changed: true };
  });
  const notifySaveFailed = vi.fn<(message: string) => void>();
  const reportError = vi.fn<(context: string, error: unknown) => void>();
  const ports: TerminalFontWeightPorts = {
    loadStored,
    save,
    notifySaveFailed,
    reportError,
    onSettingsChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    ports,
    loadStored,
    save,
    notifySaveFailed,
    reportError,
    emitChanged: (key) => listeners.forEach((listener) => listener(key)),
    listenerCount: () => listeners.size,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function track(store: { subscribe(listener: () => void): () => void; getSnapshot(): TerminalFontWeightSnapshot }): TerminalFontWeightSnapshot[] {
  const seen: TerminalFontWeightSnapshot[] = [];
  store.subscribe(() => seen.push(store.getSnapshot()));
  return seen;
}

async function connected(h: Harness): Promise<ReturnType<typeof createTerminalFontWeightStore>> {
  const store = createTerminalFontWeightStore(h.ports);
  store.connect();
  await settle();
  return store;
}

describe('terminal font weight store — load', () => {
  it('starts at 400 and not ready', () => {
    const store = createTerminalFontWeightStore(harness(700).ports);
    expect(store.getSnapshot()).toEqual({ weight: 400, ready: false });
  });

  it('publishes a stored weight once, without writing', async () => {
    const h = harness(700);
    const store = createTerminalFontWeightStore(h.ports);
    const seen = track(store);
    store.connect();
    await settle();
    expect(seen).toEqual([{ weight: 700, ready: true }]);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it('becomes ready at 400 with no write and no error when nothing is stored (AC3)', async () => {
    const h = harness(null);
    const store = await connected(h);
    expect(store.getSnapshot()).toEqual({ weight: 400, ready: true });
    expect(h.save).not.toHaveBeenCalled();
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it.each([[450], [1000], [0], ['bold'], ['700']])(
    'falls back to 400, reports the invalid stored value %j once and does not rewrite it (AC9)',
    async (stored) => {
      const h = harness(stored);
      const store = await connected(h);
      expect(store.getSnapshot()).toEqual({ weight: 400, ready: true });
      expect(h.reportError).toHaveBeenCalledTimes(1);
      expect(h.save).not.toHaveBeenCalled();
    },
  );

  it('becomes ready at 400 and reports the error when the stored value cannot be loaded', async () => {
    const h = harness(null);
    const failure = new Error('ipc down');
    h.loadStored.mockRejectedValueOnce(failure);
    const store = await connected(h);
    expect(store.getSnapshot()).toEqual({ weight: 400, ready: true });
    expect(h.reportError).toHaveBeenCalledWith(expect.any(String), failure);
  });

  it('keeps the current weight when a later refresh finds an invalid value', async () => {
    const h = harness(600);
    const store = await connected(h);
    h.loadStored.mockResolvedValue(450);
    h.emitChanged(KEY);
    await settle();
    expect(store.getSnapshot()).toEqual({ weight: 600, ready: true });
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });
});

describe('terminal font weight store — setWeight', () => {
  it('applies the new weight synchronously, then persists it (AC2)', async () => {
    const h = harness(400);
    const store = await connected(h);
    store.setWeight(600);
    expect(store.getSnapshot()).toEqual({ weight: 600, ready: true });
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.save).toHaveBeenCalledWith(600);
  });

  it('is a no-op without IPC when asked for the current weight (AC2)', async () => {
    const h = harness(500);
    const store = await connected(h);
    const seen = track(store);
    store.setWeight(500);
    await settle();
    expect(h.save).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('ignores setWeight before the stored weight has loaded', () => {
    const h = harness(700);
    const store = createTerminalFontWeightStore(h.ports);
    store.setWeight(300);
    expect(h.save).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toEqual({ weight: 400, ready: false });
  });

  it('drops a stale refresh that resolves after a newer setWeight', async () => {
    const h = harness(400);
    const store = await connected(h);
    const stale = deferred<unknown>();
    h.loadStored.mockReturnValueOnce(stale.promise);
    h.emitChanged(KEY);
    store.setWeight(800);
    stale.resolve(200);
    await settle();
    expect(store.getSnapshot().weight).toBe(800);
  });
});

describe('terminal font weight store — settings:changed (AC11)', () => {
  it('re-reads and publishes the stored weight when the key changes in another window', async () => {
    const h = harness(400);
    const store = await connected(h);
    h.loadStored.mockResolvedValue(900);
    h.emitChanged(KEY);
    await settle();
    expect(store.getSnapshot()).toEqual({ weight: 900, ready: true });
  });

  it('does not notify again when the broadcast echoes this window\'s own save', async () => {
    const h = harness(400);
    const store = await connected(h);
    const seen = track(store);
    store.setWeight(300);
    await settle();
    h.emitChanged(KEY);
    await settle();
    expect(seen).toEqual([{ weight: 300, ready: true }]);
  });

  it('ignores changes to other settings keys', async () => {
    const h = harness(400);
    await connected(h);
    h.loadStored.mockClear();
    h.emitChanged('terminal_font_size');
    await settle();
    expect(h.loadStored).not.toHaveBeenCalled();
  });

  it('stops listening and publishing after disconnect', async () => {
    const h = harness(700);
    const store = createTerminalFontWeightStore(h.ports);
    const seen = track(store);
    const disconnect = store.connect();
    disconnect();
    h.emitChanged(KEY);
    await settle();
    expect(h.listenerCount()).toBe(0);
    expect(seen).toEqual([]);
  });

  it('does not publish the revert of a save that fails after disconnect', async () => {
    const h = harness(400);
    const store = createTerminalFontWeightStore(h.ports);
    const disconnect = store.connect();
    await settle();
    const save = deferred<unknown>();
    h.save.mockReturnValueOnce(save.promise.then(() => Promise.reject(new Error('disk full'))));
    store.setWeight(700);
    const seen = track(store);
    disconnect();
    save.resolve(undefined);
    await settle();
    expect(seen).toEqual([]);
    expect(store.getSnapshot()).toEqual({ weight: 700, ready: true });
  });
});

describe('terminal font weight store — failed save (AC10)', () => {
  it('reverts to the stored weight, toasts the exact copy once and reports the cause', async () => {
    const h = harness(400);
    const store = await connected(h);
    const failure = new Error('disk full');
    h.save.mockRejectedValueOnce(failure);
    store.setWeight(700);
    expect(store.getSnapshot().weight).toBe(700);
    await settle();
    expect(store.getSnapshot()).toEqual({ weight: 400, ready: true });
    expect(h.notifySaveFailed).toHaveBeenCalledTimes(1);
    expect(h.notifySaveFailed).toHaveBeenCalledWith(FONT_COPY.terminalWeightSaveFailed);
    expect(h.reportError).toHaveBeenCalledWith(expect.any(String), failure);
    expect(h.save).toHaveBeenCalledTimes(1);
  });
});
