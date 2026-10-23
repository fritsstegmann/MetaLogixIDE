/** Controller-side display of Fleet notices and the validated fleet:viewing payload. */
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { FleetNoticeEvent } from '@main/fleet/service';
import type { NavWindow } from '@main/notifications/install';
import {
  FleetNoticeNotifier,
  installFleetNotices,
  parseFleetViewing,
} from '@main/notifications/fleet-notices';

const PEER = 'a'.repeat(64);
const NOTICE: FleetNoticeEvent = {
  peerId: PEER,
  peerName: 'Laptop',
  projectId: 7,
  projectName: 'api',
  shellIndex: 2,
  kind: 'needs-input',
  body: 'Claude needs your permission',
};

interface Shown {
  title: string;
  body: string;
  onClick: () => void;
  closed: boolean;
}

function setup(opts: { supported?: boolean; viewing?: boolean } = {}) {
  const shown: Shown[] = [];
  const toggles = { notify_claude_needs_input: true, notify_claude_finished: true };
  const deps = {
    notifications: {
      isSupported: () => opts.supported ?? true,
      show: (o: { title: string; body: string; onClick: () => void }) => {
        const entry: Shown = { ...o, closed: false };
        shown.push(entry);
        return {
          close: () => {
            entry.closed = true;
          },
        };
      },
    },
    isViewing: vi.fn(() => opts.viewing ?? false),
    navigate: vi.fn(),
    settings: { get: (key: keyof typeof toggles) => toggles[key] },
  };
  return { notifier: new FleetNoticeNotifier(deps), deps, shown, toggles };
}

describe('FleetNoticeNotifier', () => {
  it('shows the host body under a title naming the project, peer and shell', () => {
    const { notifier, shown } = setup();
    notifier.handle(NOTICE);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      title: 'api on Laptop — shell 2',
      body: 'Claude needs your permission',
    });
  });

  it('says "remote project" when the project name is unknown', () => {
    const { notifier, shown } = setup();
    notifier.handle({ ...NOTICE, projectName: null });
    expect(shown[0]!.title).toBe('remote project on Laptop — shell 2');
  });

  it("applies the controller's needs-input and finished toggles separately", () => {
    const { notifier, shown, toggles } = setup();
    toggles.notify_claude_needs_input = false;
    notifier.handle(NOTICE);
    expect(shown).toEqual([]);
    notifier.handle({
      ...NOTICE,
      kind: 'finished',
      body: 'Claude finished and is waiting for you',
    });
    expect(shown.map((s) => s.body)).toEqual(['Claude finished and is waiting for you']);
    toggles.notify_claude_needs_input = true;
    toggles.notify_claude_finished = false;
    notifier.handle({ ...NOTICE, kind: 'finished', shellIndex: 3 });
    expect(shown).toHaveLength(1);
  });

  it('holds the notice back while the window views that exact shell', () => {
    const { notifier, deps, shown } = setup({ viewing: true });
    notifier.handle(NOTICE);
    expect(deps.isViewing).toHaveBeenCalledWith({ peerId: PEER, projectId: 7, shellIndex: 2 });
    expect(shown).toEqual([]);
  });

  it('shows nothing when notifications are unsupported', () => {
    const { notifier, shown } = setup({ supported: false });
    notifier.handle(NOTICE);
    expect(shown).toEqual([]);
  });

  it('navigates to exactly the remote shell the notice came from on click', () => {
    const { notifier, deps, shown } = setup();
    notifier.handle(NOTICE);
    notifier.handle({ ...NOTICE, shellIndex: 4 });
    shown[0]!.onClick();
    expect(deps.navigate).toHaveBeenCalledTimes(1);
    expect(deps.navigate).toHaveBeenCalledWith({ peerId: PEER, projectId: 7, shellIndex: 2 });
  });

  it('replaces the outstanding notice of the same remote shell only', () => {
    const { notifier, shown } = setup();
    notifier.handle(NOTICE);
    notifier.handle({ ...NOTICE, shellIndex: 3 });
    notifier.handle({ ...NOTICE, peerId: 'b'.repeat(64) });
    notifier.handle({
      ...NOTICE,
      kind: 'finished',
      body: 'Claude finished and is waiting for you',
    });
    expect(shown.map((s) => s.closed)).toEqual([true, false, false, false]);
  });
});

describe('parseFleetViewing', () => {
  it('accepts a shell reference or null and copies only the known fields', () => {
    expect(parseFleetViewing({ shell: null })).toBeNull();
    expect(parseFleetViewing({ shell: { peerId: PEER, projectId: 7, shellIndex: 0 } })).toEqual({
      peerId: PEER,
      projectId: 7,
      shellIndex: 0,
    });
  });

  it('rejects every malformed or cast payload', () => {
    const shell = { peerId: PEER, projectId: 7, shellIndex: 0 };
    for (const bad of [
      null,
      undefined,
      'x',
      [],
      {},
      { shell: undefined },
      { shell: [] },
      { shell: 'a' },
      { shell, extra: true },
      { shell: { ...shell, extra: true } },
      { shell: { projectId: 7, shellIndex: 0 } },
      { shell: { ...shell, peerId: 'A'.repeat(64) } },
      { shell: { ...shell, peerId: 'a'.repeat(63) } },
      { shell: { ...shell, peerId: 42 } },
      { shell: { ...shell, projectId: 0 } },
      { shell: { ...shell, projectId: -1 } },
      { shell: { ...shell, projectId: 1.5 } },
      { shell: { ...shell, projectId: '7' } },
      { shell: { ...shell, projectId: 1_000_001 } },
      { shell: { ...shell, shellIndex: -1 } },
      { shell: { ...shell, shellIndex: Number.NaN } },
    ])
      expect(() => parseFleetViewing(bad), JSON.stringify(bad)).toThrow(/invalid fleet:viewing/);
  });
});

class FakeNotification extends EventEmitter {
  static instances: FakeNotification[] = [];
  static isSupported(): boolean {
    return true;
  }
  constructor(public readonly opts: { title: string; body: string }) {
    super();
    FakeNotification.instances.push(this);
  }
  show(): void {}
  close(): void {}
}

function fakeWindow(minimized = false): NavWindow & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isDestroyed: () => false,
    isMinimized: () => minimized,
    restore: () => {
      calls.push('restore');
    },
    show: () => {
      calls.push('show');
    },
    focus: () => {
      calls.push('focus');
    },
  };
}

function installSetup(
  opts: {
    focused?: 'main' | 'other' | null;
    viewing?: { peerId: string; projectId: number; shellIndex: number } | null;
  } = {},
) {
  FakeNotification.instances = [];
  const main = fakeWindow(true);
  const other = fakeWindow();
  const broadcast = vi.fn();
  let emit: (event: FleetNoticeEvent) => void = () => {};
  installFleetNotices({
    fleet: {
      onNotice: (listener) => {
        emit = listener;
        return () => {};
      },
      viewing: () => opts.viewing ?? null,
    },
    settings: { get: () => true },
    notificationClass: FakeNotification,
    windows: {
      main: () => main,
      focused: () => (opts.focused === 'main' ? main : opts.focused === 'other' ? other : null),
    },
    broadcast,
  });
  return { emit: (event: FleetNoticeEvent) => emit(event), main, broadcast };
}

describe('installFleetNotices', () => {
  const ref = { peerId: PEER, projectId: 7, shellIndex: 2 };

  it('shows a notice and on click raises main and broadcasts the remote shell to focus', () => {
    const { emit, main, broadcast } = installSetup();
    emit(NOTICE);
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]!.opts.title).toBe('api on Laptop — shell 2');
    FakeNotification.instances[0]!.emit('click');
    expect(main.calls).toEqual(['restore', 'show', 'focus']);
    expect(broadcast).toHaveBeenCalledWith('fleet:focus-remote-shell', ref);
  });

  it('suppresses only while the focused main window views that exact remote shell', () => {
    installSetup({ focused: 'main', viewing: ref }).emit(NOTICE);
    expect(FakeNotification.instances).toHaveLength(0);
    for (const viewing of [
      { ...ref, shellIndex: 3 },
      { ...ref, projectId: 8 },
      { ...ref, peerId: 'b'.repeat(64) },
      null,
    ]) {
      installSetup({ focused: 'main', viewing }).emit(NOTICE);
      expect(FakeNotification.instances).toHaveLength(1);
    }
    installSetup({ focused: 'other', viewing: ref }).emit(NOTICE);
    expect(FakeNotification.instances).toHaveLength(1);
    installSetup({ focused: null, viewing: ref }).emit(NOTICE);
    expect(FakeNotification.instances).toHaveLength(1);
  });
});
