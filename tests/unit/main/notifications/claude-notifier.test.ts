import { describe, it, expect, vi } from 'vitest';
import { ClaudeNotifier, withoutHookConfirmed } from '@main/notifications/claude-notifier';
import type { ReceivedHook } from '@main/claude-hooks/receiver';
import type { ShellKey } from '@main/claude-hooks/session-registry';

const API0: ShellKey = { projectId: 1, shellIndex: 0 };
const WEB2: ShellKey = { projectId: 2, shellIndex: 2 };

interface Shown { title: string; body: string; onClick: () => void; closed: boolean }

function setup(opts: { supported?: boolean; viewing?: (s: ShellKey) => boolean } = {}) {
  const shown: Shown[] = [];
  const toggles = { notify_claude_needs_input: true, notify_claude_finished: true };
  const confirmed: string[] = [];
  const live = new Set(['sess-api', 'sess-web']);
  const deps = {
    notifications: {
      isSupported: vi.fn(() => opts.supported ?? true),
      show: vi.fn((o: { title: string; body: string; onClick: () => void }) => {
        const entry: Shown = { ...o, closed: false };
        shown.push(entry);
        return { close: () => { entry.closed = true; } };
      }),
    },
    isViewing: vi.fn(opts.viewing ?? (() => false)),
    navigate: vi.fn(),
    settings: { get: vi.fn((k: keyof typeof toggles) => toggles[k]) },
    projectName: (id: number) => ({ 1: 'api', 2: 'web' } as Record<number, string>)[id] ?? null,
    sessions: { confirm: vi.fn((id: string) => { if (!live.has(id)) return false; confirmed.push(id); return true; }) },
  };
  return { notifier: new ClaudeNotifier(deps), deps, shown, toggles, confirmed, live };
}

function notification(shell: ShellKey, type: string | null, message: string | null = 'Claude needs your permission', sessionId = shell === WEB2 ? 'sess-web' : 'sess-api'): ReceivedHook {
  return { sessionId, shell, event: { hookEventName: 'Notification', notificationType: type, message } };
}

function stop(shell: ShellKey, sessionId = shell === WEB2 ? 'sess-web' : 'sess-api'): ReceivedHook {
  return { sessionId, shell, event: { hookEventName: 'Stop', notificationType: null, message: null } };
}

describe('ClaudeNotifier — content (AC1, AC2, AC9, AC10)', () => {
  it('a needs-input event shows exactly one notification with the project/shell title and Claude message', () => {
    const { notifier, shown } = setup();
    notifier.handle(notification(API0, 'permission_prompt', 'Claude needs your permission to use Bash'));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ title: 'api — shell 0', body: 'Claude needs your permission to use Bash' });
  });

  it('a finished event shows the fixed body and never response text', () => {
    const { notifier, shown } = setup();
    notifier.handle({ sessionId: 'sess-web', shell: WEB2, event: { hookEventName: 'Stop', notificationType: null, message: 'the reply' } });
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ title: 'web — shell 2', body: 'Claude finished and is waiting for you' });
  });

  it('truncates a long message to 200 characters', () => {
    const { notifier, shown } = setup();
    const long = 'x'.repeat(150) + 'y'.repeat(100);
    notifier.handle(notification(API0, 'permission_prompt', long));
    expect(shown[0]!.body).toBe(long.slice(0, 200));
  });

  it('does not split a surrogate pair at the 200-character cut', () => {
    const { notifier, shown } = setup();
    notifier.handle(notification(API0, 'elicitation_dialog', `${'a'.repeat(199)}😀😀`));
    expect(shown[0]!.body).toBe(`${'a'.repeat(199)}😀`);
  });

  it('strips control characters before truncating', () => {
    const { notifier, shown } = setup();
    notifier.handle(notification(API0, 'permission_prompt', 'Claude\x07needs\u0000your\r\npermission\u009b\x1b'));
    expect(shown[0]!.body).toBe('Claude needs your permission');
  });

  it.each([[null], [''], ['   '], ['\x07\x1b\u0000']])('message %j falls back to "Claude needs your input"', (message) => {
    const { notifier, shown } = setup();
    notifier.handle(notification(API0, 'agent_needs_input', message));
    expect(shown[0]!.body).toBe('Claude needs your input');
  });

  it('an unknown project falls back to its id in the title', () => {
    const { notifier, shown } = setup();
    notifier.handle({ ...stop({ projectId: 7, shellIndex: 3 }), sessionId: 'sess-api' });
    expect(shown[0]!.title).toBe('#7 — shell 3');
  });
});

describe('ClaudeNotifier — ignored events (AC3)', () => {
  it.each([['idle_prompt'], ['auth_success'], [null]])('Notification/%s shows nothing', (type) => {
    const { notifier, shown } = setup();
    notifier.handle(notification(API0, type));
    expect(shown).toHaveLength(0);
  });

  it.each([['SubagentStop'], ['UserPromptSubmit']])('%s shows nothing', (name) => {
    const { notifier, shown } = setup();
    notifier.handle({ sessionId: 'sess-api', shell: API0, event: { hookEventName: name, notificationType: null, message: null } });
    expect(shown).toHaveLength(0);
  });
});

describe('ClaudeNotifier — hook confirmation (AC18)', () => {
  it('any event, even an ignored one, confirms the session', () => {
    const { notifier, confirmed } = setup();
    notifier.handle({ sessionId: 'sess-api', shell: API0, event: { hookEventName: 'UserPromptSubmit', notificationType: null, message: null } });
    expect(confirmed).toEqual(['sess-api']);
  });

  it('confirms even when the toggles are off and nothing is shown', () => {
    const { notifier, confirmed, toggles, shown } = setup();
    toggles.notify_claude_finished = false;
    notifier.handle(stop(API0));
    expect(confirmed).toEqual(['sess-api']);
    expect(shown).toHaveLength(0);
  });

  it('an event for a released session (processed after exit) shows nothing (AC26)', () => {
    const { notifier, shown, live } = setup();
    live.delete('sess-api');
    notifier.handle(stop(API0));
    expect(shown).toHaveLength(0);
  });
});

describe('ClaudeNotifier — toggles (AC20, AC21)', () => {
  it('needs-input off suppresses needs-input only', () => {
    const { notifier, shown, toggles } = setup();
    toggles.notify_claude_needs_input = false;
    notifier.handle(notification(API0, 'permission_prompt'));
    notifier.handle(stop(WEB2));
    expect(shown.map((s) => s.body)).toEqual(['Claude finished and is waiting for you']);
  });

  it('finished off suppresses finished only', () => {
    const { notifier, shown, toggles } = setup();
    toggles.notify_claude_finished = false;
    notifier.handle(stop(API0));
    notifier.handle(notification(WEB2, 'permission_prompt'));
    expect(shown.map((s) => s.body)).toEqual(['Claude needs your permission']);
  });

  it('reads the toggle at event time, so a change applies to the next event', () => {
    const { notifier, shown, toggles } = setup();
    notifier.handle(stop(API0));
    toggles.notify_claude_finished = false;
    notifier.handle(stop(API0));
    toggles.notify_claude_finished = true;
    notifier.handle(stop(API0));
    expect(shown).toHaveLength(2);
  });
});

describe('ClaudeNotifier — suppression', () => {
  it('shows nothing when notifications are unsupported (AC25)', () => {
    const { notifier, shown } = setup({ supported: false });
    notifier.handle(stop(API0));
    expect(shown).toHaveLength(0);
  });

  it('shows nothing while the user is viewing the shell (AC15)', () => {
    const { notifier, shown, deps } = setup({ viewing: (s) => s.projectId === API0.projectId && s.shellIndex === API0.shellIndex });
    notifier.handle(stop(API0));
    notifier.handle(stop(WEB2));
    expect(shown.map((s) => s.title)).toEqual(['web — shell 2']);
    expect(deps.isViewing).toHaveBeenCalledWith(API0);
  });
});

describe('ClaudeNotifier — one outstanding per shell (AC14) and attribution (AC4)', () => {
  it('a second notification for a shell closes the first', () => {
    const { notifier, shown } = setup();
    notifier.handle(notification(API0, 'permission_prompt'));
    notifier.handle(stop(API0));
    expect(shown).toHaveLength(2);
    expect(shown[0]!.closed).toBe(true);
    expect(shown[1]!.closed).toBe(false);
  });

  it("another shell's notification does not close it", () => {
    const { notifier, shown } = setup();
    notifier.handle(stop(API0));
    notifier.handle(stop(WEB2));
    expect(shown[0]!.closed).toBe(false);
  });

  it('clicking navigates to the shell the event came from, never the other one', () => {
    const { notifier, shown, deps } = setup();
    notifier.handle(stop(API0));
    notifier.handle(stop(WEB2));
    shown[1]!.onClick();
    expect(deps.navigate).toHaveBeenCalledTimes(1);
    expect(deps.navigate).toHaveBeenCalledWith(WEB2);
    shown[0]!.onClick();
    expect(deps.navigate).toHaveBeenLastCalledWith(API0);
  });
});

describe('ClaudeNotifier — shell exit (AC26)', () => {
  it('closes the outstanding notification for that shell only', () => {
    const { notifier, shown } = setup();
    notifier.handle(stop(API0));
    notifier.handle(stop(WEB2));
    notifier.shellExited(API0);
    expect(shown[0]!.closed).toBe(true);
    expect(shown[1]!.closed).toBe(false);
  });

  it('is a no-op for a shell without a notification, and forgets the closed one', () => {
    const { notifier, shown } = setup();
    expect(() => notifier.shellExited(API0)).not.toThrow();
    notifier.handle(stop(API0));
    notifier.shellExited(API0);
    shown[0]!.closed = false;
    notifier.shellExited(API0);
    expect(shown[0]!.closed).toBe(false);
  });
});

describe('withoutHookConfirmed (AC18, AC19)', () => {
  it('drops confirmed shells and keeps the rest, preserving extra fields', () => {
    const done = [{ ...API0, durationMs: 9000 }, { ...WEB2, durationMs: 12000 }, { projectId: 3, shellIndex: 0, durationMs: 8000 }];
    const confirmed = (s: ShellKey) => s.projectId === 2;
    expect(withoutHookConfirmed(done, confirmed)).toEqual([done[0], done[2]]);
  });

  it('keeps everything when nothing is confirmed', () => {
    const done = [{ ...API0, durationMs: 9000 }];
    expect(withoutHookConfirmed(done, () => false)).toEqual(done);
  });
});
