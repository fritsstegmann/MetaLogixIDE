import { describe, it, expect, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { registerIpc } from '@main/ipc/register';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { SettingsRepo } from '@main/repos/settings-repo';
import { ViewedShells } from '@main/notifications/viewed-shells';
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
      'files:tree', 'app:ping', 'notifications:viewed-shells',
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

  describe('notifications:viewed-shells', () => {
    const main = {};
    const mainFocused = { focused: () => main, main: () => main, popout: () => null };

    function setupViewed() {
      const ipc = fakeIpcMain();
      const viewedShells = new ViewedShells();
      const services = { viewedShells } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, () => {});
      return { handler: ipc.handlers.get('notifications:viewed-shells')!, viewedShells };
    }

    it('a valid payload replaces the reported view', async () => {
      const { handler, viewedShells } = setupViewed();
      await expect(handler({}, { shells: [{ projectId: 3, shellIndex: 1 }] })).resolves.toEqual({ ok: true });
      expect(viewedShells.isViewing({ projectId: 3, shellIndex: 1 }, mainFocused)).toBe(true);
      await handler({}, { shells: [] });
      expect(viewedShells.isViewing({ projectId: 3, shellIndex: 1 }, mainFocused)).toBe(false);
    });

    it.each([
      ['more than 8 items', { shells: Array.from({ length: 9 }, (_, i) => ({ projectId: 1, shellIndex: i })) }],
      ['a non-integer id', { shells: [{ projectId: 1.5, shellIndex: 0 }] }],
      ['a negative shell index', { shells: [{ projectId: 1, shellIndex: -1 }] }],
      ['projectId 0', { shells: [{ projectId: 0, shellIndex: 0 }] }],
      ['a non-array', { shells: 'all' }],
    ])('rejects %s and leaves the view unchanged', async (_label, req) => {
      const { handler, viewedShells } = setupViewed();
      await handler({}, { shells: [{ projectId: 3, shellIndex: 1 }] });
      await expect(handler({}, req)).rejects.toThrow(/viewed shells/);
      expect(viewedShells.isViewing({ projectId: 3, shellIndex: 1 }, mainFocused)).toBe(true);
    });
  });
});
