import { describe, it, expect, vi, afterEach } from 'vitest';
import { inspect } from 'node:util';
import { ClaudeStateTracker, STALE_BUSY_MS } from '@main/claude-status/state-tracker';
import type { ReceivedHook } from '@main/claude-hooks/receiver';
import type { ShellKey } from '@main/claude-hooks/session-registry';
import type { ClaudeShellStateEntry } from '@shared/claude-state';

const A: ShellKey = { projectId: 1, shellIndex: 0 };
const B: ShellKey = { projectId: 1, shellIndex: 1 };
const C: ShellKey = { projectId: 2, shellIndex: 0 };
const k = (s: ShellKey) => `${s.projectId}:${s.shellIndex}`;

function setup() {
  const current = new Map<string, string>();
  let seq = 0;
  const clock = { now: 1_000_000 };
  const output = new Map<string, number>();
  const sessions = {
    confirm: vi.fn((id: string) => [...current.values()].includes(id)),
    currentId: vi.fn((shell: ShellKey) => current.get(k(shell)) ?? null),
  };
  const lastOutputAt = vi.fn((shell: ShellKey) => output.get(k(shell)) ?? null);
  const tracker = new ClaudeStateTracker({ sessions, lastOutputAt, now: () => clock.now });
  const changes: ClaudeShellStateEntry[] = [];
  tracker.onChange((e) => changes.push(e));
  const issue = (shell: ShellKey): string => { const id = `sess-${++seq}`; current.set(k(shell), id); return id; };
  const release = (shell: ShellKey) => current.delete(k(shell));
  const hook = (shell: ShellKey, hookEventName: string, notificationType: string | null = null, sessionId = current.get(k(shell)) ?? 'none'): ReceivedHook =>
    ({ sessionId, shell: { ...shell }, event: { hookEventName, notificationType, message: null } });
  const send = (shell: ShellKey, name: string, type: string | null = null) => tracker.handle(hook(shell, name, type));
  const advance = (ms: number) => { clock.now += ms; };
  const outputNow = (shell: ShellKey) => output.set(k(shell), clock.now);
  return { tracker, sessions, lastOutputAt, changes, issue, release, hook, send, advance, outputNow, clock };
}

const toBlocked = (t: ReturnType<typeof setup>, s: ShellKey) => t.send(s, 'PermissionRequest');

afterEach(() => vi.restoreAllMocks());

describe('ClaudeStateTracker — start state (AC1, AC10)', () => {
  it('a newly issued hook-tracked shell is idle before any event and emits nothing (AC1)', () => {
    const t = setup();
    t.issue(A);
    expect(t.tracker.stateOf(A)).toBe('idle');
    expect(t.tracker.list()).toEqual([]);
    expect(t.changes).toEqual([]);
  });

  it('a shell without a hook session is idle and not listed (AC10)', () => {
    const t = setup();
    expect(t.tracker.stateOf(C)).toBe('idle');
    t.tracker.handle(t.hook(C, 'UserPromptSubmit', null, 'forged-session'));
    t.tracker.onInput(C, '\r');
    t.tracker.tick();
    expect(t.tracker.stateOf(C)).toBe('idle');
    expect(t.tracker.list()).toEqual([]);
    expect(t.changes).toEqual([]);
  });
});

describe('ClaudeStateTracker — hook transitions (AC2–AC6)', () => {
  it('UserPromptSubmit → busy for that shell only, with one change (AC2)', () => {
    const t = setup();
    t.issue(A); t.issue(B); t.issue(C);
    t.send(A, 'UserPromptSubmit');
    expect(t.tracker.stateOf(A)).toBe('busy');
    expect(t.tracker.stateOf(B)).toBe('idle');
    expect(t.tracker.stateOf(C)).toBe('idle');
    expect(t.changes).toEqual([{ projectId: 1, shellIndex: 0, state: 'busy' }]);
  });

  it.each(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])('%s → busy from idle, busy and blocked (AC3)', (name) => {
    const t = setup();
    t.issue(A);
    t.send(A, name);
    expect(t.tracker.stateOf(A)).toBe('busy');
    t.send(A, name);
    expect(t.tracker.stateOf(A)).toBe('busy');
    toBlocked(t, A);
    t.send(A, name);
    expect(t.tracker.stateOf(A)).toBe('busy');
    expect(t.changes.map((c) => c.state)).toEqual(['busy', 'blocked', 'busy']);
  });

  it('PermissionRequest → blocked from idle and from busy (AC4)', () => {
    const t = setup();
    t.issue(A); t.issue(B);
    t.send(A, 'PermissionRequest');
    t.send(B, 'UserPromptSubmit');
    t.send(B, 'PermissionRequest');
    expect(t.tracker.stateOf(A)).toBe('blocked');
    expect(t.tracker.stateOf(B)).toBe('blocked');
  });

  it.each(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'])('Notification/%s → blocked (AC4)', (type) => {
    const t = setup();
    t.issue(A);
    t.send(A, 'UserPromptSubmit');
    t.send(A, 'Notification', type);
    expect(t.tracker.stateOf(A)).toBe('blocked');
  });

  it.each([
    ['Notification', 'auth_success'], ['Notification', 'elicitation_complete'], ['Notification', null],
    ['PermissionDenied', null], ['SubagentStop', null], ['SomeFutureEvent', null],
  ])('%s/%s leaves idle, busy and blocked unchanged, with no change emitted (AC5)', (name, type) => {
    const t = setup();
    t.issue(A); t.issue(B); t.issue(C);
    t.send(B, 'UserPromptSubmit');
    toBlocked(t, C);
    const before = t.changes.length;
    for (const s of [A, B, C]) t.send(s, name, type);
    expect([A, B, C].map((s) => t.tracker.stateOf(s))).toEqual(['idle', 'busy', 'blocked']);
    expect(t.changes).toHaveLength(before);
  });

  it.each([['Stop', null], ['StopFailure', null], ['Notification', 'idle_prompt']])('%s/%s → idle from busy and blocked (AC6)', (name, type) => {
    const t = setup();
    t.issue(A); t.issue(B);
    t.send(A, 'UserPromptSubmit');
    toBlocked(t, B);
    t.send(A, name, type);
    t.send(B, name, type);
    expect(t.tracker.stateOf(A)).toBe('idle');
    expect(t.tracker.stateOf(B)).toBe('idle');
    expect(t.changes.slice(-2)).toEqual([{ projectId: 1, shellIndex: 0, state: 'idle' }, { projectId: 1, shellIndex: 1, state: 'idle' }]);
    expect(t.tracker.list()).toEqual([]);
  });

  it('Stop on an idle shell emits nothing', () => {
    const t = setup();
    t.issue(A);
    t.send(A, 'Stop');
    expect(t.changes).toEqual([]);
  });

  it('confirms the session of every event it handles', () => {
    const t = setup();
    const id = t.issue(A);
    t.send(A, 'SubagentStop');
    expect(t.sessions.confirm).toHaveBeenCalledWith(id);
  });
});

describe('ClaudeStateTracker — answering input (AC7)', () => {
  it.each(['\r', 'yes\r', '\x1b', '\x03', '1', '9'])('%j to a blocked shell → busy, once', (data) => {
    const t = setup();
    t.issue(A);
    toBlocked(t, A);
    t.tracker.onInput(A, data);
    expect(t.tracker.stateOf(A)).toBe('busy');
    expect(t.changes.at(-1)).toEqual({ projectId: 1, shellIndex: 0, state: 'busy' });
    expect(t.changes).toHaveLength(2);
  });

  it.each(['\x1b[I', '\x1b[O', '\x1b[12;40R', '\x1b[?1;2c', '\x1b[A', 'a', '0'])('%j leaves a blocked shell blocked', (data) => {
    const t = setup();
    t.issue(A);
    toBlocked(t, A);
    t.tracker.onInput(A, data);
    expect(t.tracker.stateOf(A)).toBe('blocked');
    expect(t.changes).toHaveLength(1);
  });

  it('answering input changes neither an idle nor a busy shell', () => {
    const t = setup();
    t.issue(A); t.issue(B);
    t.send(B, 'UserPromptSubmit');
    for (const d of ['\r', '\x1b', '\x03', '1']) { t.tracker.onInput(A, d); t.tracker.onInput(B, d); }
    expect(t.tracker.stateOf(A)).toBe('idle');
    expect(t.tracker.stateOf(B)).toBe('busy');
    expect(t.changes).toHaveLength(1);
  });

  it('input to one blocked shell does not unblock another', () => {
    const t = setup();
    t.issue(A); t.issue(B);
    toBlocked(t, A); toBlocked(t, B);
    t.tracker.onInput(A, '\r');
    expect(t.tracker.stateOf(B)).toBe('blocked');
  });

  it('input to a shell whose blocked entry belongs to a replaced session changes nothing', () => {
    const t = setup();
    t.issue(A);
    toBlocked(t, A);
    t.issue(A);
    t.tracker.onInput(A, '\r');
    expect(t.tracker.stateOf(A)).toBe('idle');
    expect(t.changes).toHaveLength(1);
  });
});

describe('ClaudeStateTracker — stale-busy guard (AC8)', () => {
  it('uses a 15 s window', () => {
    expect(STALE_BUSY_MS).toBe(15_000);
  });

  it('busy with no output for 15 s → idle, emitted once', () => {
    const t = setup();
    t.issue(A);
    t.outputNow(A);
    t.send(A, 'UserPromptSubmit');
    t.advance(STALE_BUSY_MS - 1);
    t.tracker.tick();
    expect(t.tracker.stateOf(A)).toBe('busy');
    t.advance(1);
    t.tracker.tick();
    t.tracker.tick();
    expect(t.tracker.stateOf(A)).toBe('idle');
    expect(t.changes).toEqual([{ projectId: 1, shellIndex: 0, state: 'busy' }, { projectId: 1, shellIndex: 0, state: 'idle' }]);
  });

  it('output keeps a busy shell busy past 15 s', () => {
    const t = setup();
    t.issue(A);
    t.send(A, 'UserPromptSubmit');
    for (let i = 0; i < 10; i++) {
      t.advance(5_000);
      t.outputNow(A);
      t.tracker.tick();
    }
    expect(t.tracker.stateOf(A)).toBe('busy');
    t.advance(STALE_BUSY_MS);
    t.tracker.tick();
    expect(t.tracker.stateOf(A)).toBe('idle');
  });

  it('counts from when busy was entered, so busy after a long silence is not expired at once', () => {
    const t = setup();
    t.issue(A);
    t.outputNow(A);
    t.advance(60_000);
    t.send(A, 'UserPromptSubmit');
    t.tracker.tick();
    expect(t.tracker.stateOf(A)).toBe('busy');
    t.advance(STALE_BUSY_MS - 1);
    t.tracker.tick();
    expect(t.tracker.stateOf(A)).toBe('busy');
  });

  it('a later busy event restarts the window', () => {
    const t = setup();
    t.issue(A);
    t.send(A, 'UserPromptSubmit');
    t.advance(10_000);
    t.send(A, 'PreToolUse');
    t.advance(10_000);
    t.tracker.tick();
    expect(t.tracker.stateOf(A)).toBe('busy');
  });

  it('busy entered by answering input also restarts the window', () => {
    const t = setup();
    t.issue(A);
    t.send(A, 'UserPromptSubmit');
    toBlocked(t, A);
    t.advance(60_000);
    t.tracker.onInput(A, '\r');
    t.tracker.tick();
    expect(t.tracker.stateOf(A)).toBe('busy');
  });

  it('never expires a blocked shell', () => {
    const t = setup();
    t.issue(A);
    toBlocked(t, A);
    t.advance(10 * 60_000);
    t.tracker.tick();
    expect(t.tracker.stateOf(A)).toBe('blocked');
  });

  it('expires only the silent shell', () => {
    const t = setup();
    t.issue(A); t.issue(B);
    t.send(A, 'UserPromptSubmit');
    t.send(B, 'UserPromptSubmit');
    t.advance(STALE_BUSY_MS);
    t.outputNow(B);
    t.tracker.tick();
    expect(t.tracker.stateOf(A)).toBe('idle');
    expect(t.tracker.stateOf(B)).toBe('busy');
  });
});

describe('ClaudeStateTracker — lifecycle (AC9)', () => {
  it('exit discards a busy or blocked state and emits idle', () => {
    const t = setup();
    t.issue(A); t.issue(B);
    t.send(A, 'UserPromptSubmit');
    toBlocked(t, B);
    t.release(A); t.release(B);
    t.tracker.shellExited(A);
    t.tracker.shellExited(B);
    expect(t.changes.slice(-2)).toEqual([{ projectId: 1, shellIndex: 0, state: 'idle' }, { projectId: 1, shellIndex: 1, state: 'idle' }]);
    expect(t.tracker.list()).toEqual([]);
  });

  it('exit before the session is released still discards and emits idle', () => {
    const t = setup();
    t.issue(A);
    t.send(A, 'UserPromptSubmit');
    t.tracker.shellExited(A);
    expect(t.tracker.stateOf(A)).toBe('idle');
    expect(t.changes.at(-1)).toEqual({ projectId: 1, shellIndex: 0, state: 'idle' });
  });

  it('exit of an idle or untracked shell emits nothing', () => {
    const t = setup();
    t.issue(A);
    t.tracker.shellExited(A);
    t.tracker.shellExited(C);
    expect(t.changes).toEqual([]);
  });

  it('a respawn (re-issued session) starts idle without an event, and the old state never returns', () => {
    const t = setup();
    t.issue(A);
    toBlocked(t, A);
    t.issue(A);
    expect(t.tracker.stateOf(A)).toBe('idle');
    expect(t.tracker.list()).toEqual([]);
    expect(t.changes).toHaveLength(1);
    t.advance(STALE_BUSY_MS * 2);
    t.tracker.tick();
    expect(t.tracker.stateOf(A)).toBe('idle');
  });

  it('a respawn as a non-Claude shell (released, no new session) is idle', () => {
    const t = setup();
    t.issue(A);
    t.send(A, 'UserPromptSubmit');
    t.release(A);
    expect(t.tracker.stateOf(A)).toBe('idle');
    expect(t.tracker.list()).toEqual([]);
  });

  it('a late event from a released session is dropped and does not affect the new session', () => {
    const t = setup();
    const old = t.issue(A);
    t.issue(A);
    t.tracker.handle(t.hook(A, 'PermissionRequest', null, old));
    expect(t.tracker.stateOf(A)).toBe('idle');
    expect(t.changes).toEqual([]);
  });

  it('a stale busy entry from a replaced session is dropped by tick without an event', () => {
    const t = setup();
    t.issue(A);
    t.send(A, 'UserPromptSubmit');
    t.issue(A);
    t.advance(STALE_BUSY_MS);
    t.tracker.tick();
    t.send(A, 'UserPromptSubmit');
    expect(t.changes.map((c) => c.state)).toEqual(['busy', 'busy']);
  });

  it('after a respawn, the first busy event of the new session is emitted', () => {
    const t = setup();
    t.issue(A);
    t.send(A, 'UserPromptSubmit');
    t.issue(A);
    t.send(A, 'UserPromptSubmit');
    expect(t.changes).toHaveLength(2);
    expect(t.tracker.stateOf(A)).toBe('busy');
  });
});

describe('ClaudeStateTracker — list', () => {
  it('lists only current, non-idle shells with exactly projectId, shellIndex and state', () => {
    const t = setup();
    t.issue(A); t.issue(B); t.issue(C);
    t.send(A, 'UserPromptSubmit');
    toBlocked(t, C);
    const list = t.tracker.list();
    expect(list).toHaveLength(2);
    expect(list).toEqual(expect.arrayContaining([{ projectId: 1, shellIndex: 0, state: 'busy' }, { projectId: 2, shellIndex: 0, state: 'blocked' }]));
    for (const e of list) expect(Object.keys(e).sort()).toEqual(['projectId', 'shellIndex', 'state']);
  });

  it('returns copies, so a caller mutating an entry cannot change the tracker', () => {
    const t = setup();
    t.issue(A);
    t.send(A, 'UserPromptSubmit');
    t.tracker.list()[0]!.state = 'blocked';
    expect(t.tracker.stateOf(A)).toBe('busy');
  });

  it('an unsubscribed listener receives no more changes', () => {
    const t = setup();
    t.issue(A);
    const late: ClaudeShellStateEntry[] = [];
    const off = t.tracker.onChange((e) => late.push(e));
    t.send(A, 'UserPromptSubmit');
    off();
    t.send(A, 'Stop');
    expect(late).toEqual([{ projectId: 1, shellIndex: 0, state: 'busy' }]);
  });
});

describe('ClaudeStateTracker — security (plan §6)', () => {
  it('a change carries exactly projectId, shellIndex and state, whatever the hook carried', () => {
    const t = setup();
    t.issue(A);
    const h = t.hook(A, 'Notification', 'permission_prompt');
    const hostile = { ...h, extra: 'x', event: { ...h.event, message: 'MESSAGE-SECRET', tool_input: { command: 'TOOL-SECRET' }, prompt: 'PROMPT-SECRET' } };
    t.tracker.handle(hostile as ReceivedHook);
    expect(t.changes).toHaveLength(1);
    expect(Object.keys(t.changes[0]!).sort()).toEqual(['projectId', 'shellIndex', 'state']);
    expect(JSON.stringify(t.changes[0])).not.toMatch(/SECRET|sess-/);
  });

  it('onInput never logs the input data', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const t = setup();
    t.issue(A); t.issue(B);
    toBlocked(t, A);
    t.send(B, 'UserPromptSubmit');
    const before = spies.map((s) => s.mock.calls.length);
    t.tracker.onInput(B, 'PASSWORD-1\r');
    t.tracker.onInput(A, 'PASSWORD-2');
    t.tracker.onInput(C, 'PASSWORD-3\r');
    expect(spies.map((s) => s.mock.calls.length)).toEqual(before);
    t.tracker.onInput(A, 'PASSWORD-4\r');
    const logged = spies.flatMap((s) => s.mock.calls.map((c) => inspect(c, { depth: 5 }))).join('\n');
    expect(logged).not.toContain('PASSWORD');
  });
});

describe('ClaudeStateTracker — performance (plan §7)', () => {
  it('10 Pre/Post events while busy emit exactly one change', () => {
    const t = setup();
    t.issue(A);
    for (let i = 0; i < 5; i++) { t.send(A, 'PreToolUse'); t.send(A, 'PostToolUse'); }
    expect(t.changes).toEqual([{ projectId: 1, shellIndex: 0, state: 'busy' }]);
  });

  it('100 inputs to a busy shell emit nothing', () => {
    const t = setup();
    t.issue(A);
    t.send(A, 'UserPromptSubmit');
    const before = t.changes.length;
    for (let i = 0; i < 100; i++) t.tracker.onInput(A, i % 2 ? '\r' : 'x');
    expect(t.changes).toHaveLength(before);
  });

  it('tick with no busy shells reads no output times', () => {
    const t = setup();
    t.issue(A); t.issue(B);
    toBlocked(t, A);
    t.tracker.tick();
    expect(t.lastOutputAt).not.toHaveBeenCalled();
  });

  it('tick reads output times only for busy shells', () => {
    const t = setup();
    t.issue(A); t.issue(B);
    toBlocked(t, A);
    t.send(B, 'UserPromptSubmit');
    t.tracker.tick();
    expect(t.lastOutputAt.mock.calls).toEqual([[B]]);
  });
});
