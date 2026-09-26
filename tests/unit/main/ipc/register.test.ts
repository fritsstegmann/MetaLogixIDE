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
  return { on: vi.fn(), off: vi.fn(), spawn: vi.fn(async () => {}), kill: vi.fn(async () => {}), isAlive: vi.fn(() => false), resize: vi.fn(), write: vi.fn(), getScrollback: vi.fn(() => ''), allPorts: vi.fn(() => []), liveShells: vi.fn(() => []) };
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
});
