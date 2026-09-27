import { describe, it, expect, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { registerIpc } from '@main/ipc/register';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { SettingsRepo } from '@main/repos/settings-repo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const migrationsDir = resolve(__dirname, '../../../../migrations');

function fakeIpcMain(): IpcMain & { handlers: Map<string, (e: unknown, req: unknown) => Promise<unknown>> } {
  const handlers = new Map<string, (e: unknown, req: unknown) => Promise<unknown>>();
  return {
    handle: (channel: string, fn: (e: unknown, req: unknown) => Promise<unknown>) => handlers.set(channel, fn),
    handlers,
  } as unknown as ReturnType<typeof fakeIpcMain>;
}

/** Real SettingsRepo backed by a temp sqlite db, seeded with defaults, for tests that exercise the real permission-mode rewrite. */
function realSettings(): SettingsRepo {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'reg-')), 'db'));
  runMigrations(db, migrationsDir);
  const repo = new SettingsRepo(db);
  repo.seedDefaults();
  return repo;
}

/** Minimal ptyManager stand-in: every method is a spy, so a test can assert nothing was spawned. */
function fakePtyManager() {
  return { on: vi.fn(), off: vi.fn(), spawn: vi.fn(async () => {}), kill: vi.fn(async () => {}), isAlive: vi.fn(() => false), resize: vi.fn(), write: vi.fn(), getScrollback: vi.fn(() => ''), getSnapshot: vi.fn(async () => ''), allPorts: vi.fn(() => []), liveShells: vi.fn(() => []) };
}

describe('registerIpc', () => {
  it('registers every declared channel', async () => {
    const ipc = fakeIpcMain();
    const services = {} as unknown as Parameters<typeof registerIpc>[1]; // handlers are not invoked in this test
    registerIpc(ipc as unknown as IpcMain, services, () => {});
    const expected = [
      'roots:list', 'roots:add', 'roots:remove', 'roots:rescan',
      'projects:list', 'projects:open', 'projects:pin', 'projects:hide',
      'projects:update-config', 'projects:recents',
      'shells:launch', 'shells:kill', 'shells:resize', 'shells:write',
      'shells:alive-list', 'shells:pin',
      'settings:get', 'settings:set', 'settings:set-claude-permission-mode',
      'files:tree', 'app:ping',
      'app:set-window-material', 'app:get-window-render',
    ];
    for (const c of expected) expect(ipc.handlers.has(c)).toBe(true);
  });

  it('settings:set rejects key claude_permission_mode without writing', async () => {
    const ipc = fakeIpcMain();
    const settings = realSettings();
    const setSpy = vi.spyOn(settings, 'set');
    const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, () => {});
    const handler = ipc.handlers.get('settings:set')!;
    await expect(handler({}, { key: 'claude_permission_mode', value: 'auto' })).rejects.toThrow();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it.each(['plan', 'bypassPermissions', '', undefined])('settings:set-claude-permission-mode rejects mode %j without changing anything', async (mode) => {
    const ipc = fakeIpcMain();
    const settings = realSettings();
    const before = settings.get('claude_permission_mode');
    const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, () => {});
    const handler = ipc.handlers.get('settings:set-claude-permission-mode')!;
    await expect(handler({}, { mode })).rejects.toThrow();
    expect(settings.get('claude_permission_mode')).toBe(before);
  });

  it('shells:snapshot returns the serialized terminal state, not the raw scrollback tail', async () => {
    const ipc = fakeIpcMain();
    const ptyManager = fakePtyManager();
    ptyManager.isAlive.mockReturnValue(true);
    ptyManager.getScrollback.mockReturnValue('RAW-TAIL');
    ptyManager.getSnapshot.mockResolvedValue('\x1b[1mSERIALIZED');
    const services = { ptyManager } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, () => {});
    const result = await ipc.handlers.get('shells:snapshot')!({}, { projectId: 4, shellIndex: 2 });
    expect(result).toEqual({ output: '\x1b[1mSERIALIZED', alive: true });
    expect(ptyManager.getSnapshot).toHaveBeenCalledWith(4, 2);
  });

  it('shells:snapshot returns an empty dead snapshot when no ptyManager is wired', async () => {
    const ipc = fakeIpcMain();
    registerIpc(ipc as unknown as IpcMain, {} as unknown as Parameters<typeof registerIpc>[1], () => {});
    await expect(ipc.handlers.get('shells:snapshot')!({}, { projectId: 1, shellIndex: 0 })).resolves.toEqual({ output: '', alive: false });
  });

  it('shells:launch rejects while the permission mode is unchosen, without spawning', async () => {
    const ipc = fakeIpcMain();
    const settings = realSettings();
    expect(settings.get('claude_permission_mode')).toBeNull();
    const ptyManager = fakePtyManager();
    const services = { settings, ptyManager } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, () => {});
    const handler = ipc.handlers.get('shells:launch')!;
    await expect(handler({}, { projectId: 1 })).rejects.toThrow('Choose a Claude permission mode first');
    expect(ptyManager.spawn).not.toHaveBeenCalled();
  });

  it('settings:set-claude-permission-mode returns { mode, changedKeys } and emits settings:changed once per changed key', async () => {
    const ipc = fakeIpcMain();
    const settings = realSettings();
    const events: Array<{ channel: string; payload: unknown }> = [];
    const sendEvent = (channel: string, payload: unknown) => { events.push({ channel, payload }); };
    const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, sendEvent as never);
    const handler = ipc.handlers.get('settings:set-claude-permission-mode')!;
    const result = await handler({}, { mode: 'auto' }) as { mode: string; changedKeys: string[] };
    expect(result.mode).toBe('auto');
    expect(new Set(result.changedKeys)).toEqual(new Set(['claude_permission_mode', 'default_launch_cmd.first', 'default_launch_cmd.subsequent', 'default_cli_profiles']));
    const settingsChangedKeys = events.filter(e => e.channel === 'settings:changed').map(e => (e.payload as { key: string }).key);
    expect(new Set(settingsChangedKeys)).toEqual(new Set(result.changedKeys));
    expect(settingsChangedKeys).toHaveLength(result.changedKeys.length);
  });

  it('settings:set-claude-permission-mode emits nothing on failure', async () => {
    const ipc = fakeIpcMain();
    const settings = realSettings();
    const events: Array<{ channel: string; payload: unknown }> = [];
    const sendEvent = (channel: string, payload: unknown) => { events.push({ channel, payload }); };
    const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, sendEvent as never);
    const handler = ipc.handlers.get('settings:set-claude-permission-mode')!;
    await expect(handler({}, { mode: 'plan' })).rejects.toThrow();
    expect(events).toEqual([]);
  });

  describe('window material', () => {
    function wire(windowHooks?: Partial<Parameters<typeof registerIpc>[3]>) {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      const events: Array<{ channel: string; payload: unknown }> = [];
      const sendEvent = (channel: string, payload: unknown) => { events.push({ channel, payload }); };
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, sendEvent as never, windowHooks as Parameters<typeof registerIpc>[3]);
      return { ipc, settings, events };
    }

    it.each(['window_opacity', 'window_backdrop_blur', 'window_backdrop_saturation'])('settings:set rejects key %s without writing (AC3)', async (key) => {
      const { ipc, settings } = wire();
      const setSpy = vi.spyOn(settings, 'set');
      const setManySpy = vi.spyOn(settings, 'setMany');
      await expect(ipc.handlers.get('settings:set')!({}, { key, value: 50 })).rejects.toThrow('app:set-window-material');
      expect(setSpy).not.toHaveBeenCalled();
      expect(setManySpy).not.toHaveBeenCalled();
    });

    it('settings:set still writes an unrelated key', async () => {
      const { ipc, settings } = wire();
      await ipc.handlers.get('settings:set')!({}, { key: 'keep_alive_cap', value: 7 });
      expect(settings.get('keep_alive_cap')).toBe(7);
    });

    it('app:set-window-material with only invalid and unknown fields changes nothing and emits nothing', async () => {
      const applyWindowMaterial = vi.fn();
      const { ipc, settings, events } = wire({ applyWindowMaterial });
      const setManySpy = vi.spyOn(settings, 'setMany');
      const result = await ipc.handlers.get('app:set-window-material')!({}, { blur: 'x', saturation: Number.NaN, extra: 1 });
      expect(result).toEqual({ opacity: 100, blur: 20, saturation: 180 });
      expect(setManySpy).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      expect(applyWindowMaterial).not.toHaveBeenCalled();
    });

    it.each([null, undefined, 'x'])('app:set-window-material treats a non-object request %j as an empty patch', async (req) => {
      const { ipc, events } = wire();
      await expect(ipc.handlers.get('app:set-window-material')!({}, req)).resolves.toEqual({ opacity: 100, blur: 20, saturation: 180 });
      expect(events).toEqual([]);
    });

    it('app:set-window-material clamps { blur: 55 } and persists 40', async () => {
      const { ipc, settings } = wire();
      const result = await ipc.handlers.get('app:set-window-material')!({}, { blur: 55 });
      expect(result).toEqual({ opacity: 100, blur: 40, saturation: 180 });
      expect(settings.get('window_backdrop_blur')).toBe(40);
    });

    it('app:set-window-material emits settings:changed once per changed key and applies the normalised material', async () => {
      const applyWindowMaterial = vi.fn();
      const { ipc, events } = wire({ applyWindowMaterial });
      await ipc.handlers.get('app:set-window-material')!({}, { opacity: 64.6, blur: 20, saturation: 90 });
      expect(events.map((e) => e.channel)).toEqual(['settings:changed', 'settings:changed']);
      expect(new Set(events.map((e) => (e.payload as { key: string }).key))).toEqual(new Set(['window_opacity', 'window_backdrop_saturation']));
      expect(applyWindowMaterial).toHaveBeenCalledTimes(1);
      expect(applyWindowMaterial).toHaveBeenCalledWith({ opacity: 65, blur: 20, saturation: 100 });
    });

    it('app:set-window-material works without window hooks', async () => {
      const { ipc, settings } = wire();
      await ipc.handlers.get('app:set-window-material')!({}, { saturation: 150 });
      expect(settings.get('window_backdrop_saturation')).toBe(150);
    });

    it('app:get-window-render returns the render values for the stored material on this platform', async () => {
      const { ipc, settings } = wire();
      settings.setMany({ window_opacity: 60, window_backdrop_blur: 55, window_backdrop_saturation: 150 });
      const alpha = process.platform === 'darwin' ? 0.6 : 1;
      await expect(ipc.handlers.get('app:get-window-render')!({}, undefined)).resolves.toEqual({ surfaceAlpha: alpha, blurPx: 40, saturatePct: 150 });
    });

    it.each([
      ['window_backdrop_blur', 55, 40],
      ['window_backdrop_saturation', 90, 100],
      ['window_opacity', 12.4, 30],
    ] as const)('settings:get %s returns the clamped value when storage holds %d', async (key, raw, expected) => {
      const { ipc, settings } = wire();
      settings.set(key, raw);
      await expect(ipc.handlers.get('settings:get')!({}, { key })).resolves.toEqual({ value: expected });
    });

    it('settings:get returns an unrelated key unchanged', async () => {
      const { ipc, settings } = wire();
      settings.set('keep_alive_cap', 999);
      await expect(ipc.handlers.get('settings:get')!({}, { key: 'keep_alive_cap' })).resolves.toEqual({ value: 999 });
    });
  });
});
