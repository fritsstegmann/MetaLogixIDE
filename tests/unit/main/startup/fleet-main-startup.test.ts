import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetService } from '@main/fleet/service';

const mockedModules = [
  'electron',
  'electron-log/main',
  '@main/services',
  '@main/ipc/register',
  '@main/menu',
  '@main/notifications/install',
  '@main/agent-status/install',
  '@main/startup/boot-rescan',
  '@main/startup/done-notifier',
  '@main/startup/receivers',
  '@main/startup/crash-observability',
  '@main/domain/login-shell-path',
] as const;

afterEach(() => {
  for (const path of mockedModules) vi.doUnmock(path);
  vi.resetModules();
});

it('starts a default-off real Fleet service before opening a window and stops it on quit', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fleet-main-'));
  mkdirSync(join(home, '.metaide', 'fleet'), { recursive: true, mode: 0o700 });
  const events = new Map<string, (...args: never[]) => void>();
  let signalReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const services = {
    homeDir: home,
    settings: { get: () => null },
    ptyManager: { on: vi.fn() },
    hookReceiver: { onHook: vi.fn() },
    ompReceiver: { stop: vi.fn() },
    dropStaging: { pruneOlderThan: async () => ({ removed: 0 }) },
  };
  const built = vi.fn(() => services);
  const registered = vi.fn();
  const startNotifier = vi.fn(() => 1 as unknown as NodeJS.Timeout);
  const clearPoll = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
  const stopAgent = vi.fn();
  const calls: string[] = [];
  const loadWindow = vi.fn(async () => {
    calls.push('window');
  });
  const broadcasts = vi.fn();
  const windows: TestWindow[] = [];
  class TestWindow {
    static getAllWindows() {
      return windows;
    }
    static getFocusedWindow() {
      return null;
    }
    webContents = { on: vi.fn(), setWindowOpenHandler: vi.fn(), isDestroyed: () => false,
      isCrashed: () => false, send: broadcasts };
    constructor() { windows.push(this); }
    once = vi.fn();
    setOpacity = vi.fn();
    isDestroyed() {
      return false;
    }
    loadFile = loadWindow;
  }
  vi.doMock('electron', () => ({
    app: {
      whenReady: () => ready,
      on: (name: string, listener: (...args: never[]) => void) => {
        events.set(name, listener);
      },
      requestSingleInstanceLock: () => true,
      isPackaged: false,
      getAppPath: () => process.cwd(),
      getPath: () => home,
    },
    BrowserWindow: TestWindow,
    crashReporter: {},
    ipcMain: { handle: vi.fn() },
    Menu: { setApplicationMenu: vi.fn() },
    Notification: vi.fn(),
    screen: {},
    shell: {},
  }));
  vi.doMock('electron-log/main', () => ({
    default: {
      initialize: vi.fn(),
      transports: { file: {}, console: {} },
      functions: {},
      info: vi.fn(),
      warn: vi.fn(),
    },
  }));
  vi.doMock('@main/services', () => ({ buildServices: built }));
  vi.doMock('@main/ipc/register', () => ({
    createFleetOperations: () => ({
      status: () => ({ projects: [], shells: [] }),
      launch: async () => ({ shellIndex: 0 }),
      launchClaude: async () => ({ shellIndex: 0 }),
      resize: async () => {},
      isAlive: () => false,
      hasProject: () => false,
      watch: () => () => {},
      terminalSnapshot: async () => '',
      stop: async () => {},
      write: async () => {},
      snapshot: async () => ({ output: '', alive: false }),
    }),
    registerIpc: registered,
  }));
  vi.doMock('@main/menu', () => ({ buildAppMenu: () => null }));
  vi.doMock('@main/notifications/install', () => ({ installClaudeNotifications: vi.fn() }));
  vi.doMock('@main/agent-status/install', () => ({
    installAgentStatus: () => ({ tracker: {}, stop: stopAgent }),
  }));
  vi.doMock('@main/startup/boot-rescan', () => ({ rescanRootsAtBoot: async () => {} }));
  vi.doMock('@main/startup/done-notifier', () => ({ startDoneNotifier: startNotifier }));
  vi.doMock('@main/startup/receivers', () => ({ startReceivers: async () => {} }));
  vi.doMock('@main/startup/crash-observability', () => ({ installCrashObservability: vi.fn() }));
  vi.doMock('@main/domain/login-shell-path', () => ({
    resolveLoginShellPath: async () => process.env.PATH ?? '',
  }));
  try {
    // Bootstrap must run only after per-test Electron and service boundaries are installed.
    await import('@main/index');
    signalReady();
    await vi.waitFor(() => expect(events.has('before-quit')).toBe(true));
    expect(services).toHaveProperty('fleet');
    const fleet = Reflect.get(services, 'fleet');
    expect(fleet).toBeInstanceOf(FleetService);
    if (!(fleet instanceof FleetService)) throw new Error('Fleet startup missing');
    expect(fleet.state().enabled).toBe(false);
    expect(registered).toHaveBeenCalledOnce();
    expect(calls).toEqual(['window']);
    const listeners: unknown = Reflect.get(fleet, 'terminalListeners');
    if (!(listeners instanceof Set)) throw new Error('Fleet terminal broadcast not installed');
    const terminal = { peerId: 'a'.repeat(64), subscriptionId: 'b'.repeat(32),
      projectId: 7, shellIndex: 0, kind: 'ready', data: '' };
    for (const listener of listeners) {
      if (typeof listener !== 'function') throw new Error('Invalid terminal listener');
      listener(terminal);
    }
    expect(broadcasts).toHaveBeenCalledWith('fleet:terminal', terminal);
    events.get('before-quit')?.();
    await vi.waitFor(() => expect(Reflect.get(fleet, 'started')).toBe(false));
    expect(stopAgent).toHaveBeenCalledOnce();
    expect(services.ompReceiver.stop).toHaveBeenCalledOnce();
    expect(clearPoll).toHaveBeenCalledWith(1);
  } finally {
    clearPoll.mockRestore();
    rmSync(home, { recursive: true, force: true });
  }
});
