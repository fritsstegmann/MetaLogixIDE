import { describe, it, expect } from 'vitest';
import { classifyHookEvent, NEEDS_INPUT_TYPES, parseHookEvent, stateTransitionFor, type HookEvent } from '@main/claude-hooks/hook-event';

const common = {
  session_id: 'abc123',
  transcript_path: '/Users/x/.claude/projects/p/abc123.jsonl',
  cwd: '/Users/x/p',
};

describe('parseHookEvent', () => {
  it('parses the documented Notification example and keeps only the fields the app uses', () => {
    const raw = {
      ...common,
      hook_event_name: 'Notification',
      message: 'Claude needs your permission',
      title: 'Permission needed',
      notification_type: 'permission_prompt',
    };
    expect(parseHookEvent(raw)).toEqual({
      hookEventName: 'Notification',
      notificationType: 'permission_prompt',
      message: 'Claude needs your permission',
    });
  });

  it('parses a real Stop payload, stripping unknown fields such as last_assistant_message', () => {
    const raw = { ...common, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'secret reply', background_tasks: [] };
    const parsed = parseHookEvent(raw);
    expect(parsed).toEqual({ hookEventName: 'Stop', notificationType: null, message: null });
    expect(JSON.stringify(parsed)).not.toContain('secret reply');
  });

  it('parses a UserPromptSubmit payload without carrying the prompt', () => {
    const parsed = parseHookEvent({ ...common, hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' });
    expect(parsed).toEqual({ hookEventName: 'UserPromptSubmit', notificationType: null, message: null });
  });

  it.each([
    ['null', null],
    ['an array', [{ hook_event_name: 'Stop' }]],
    ['a string', 'Stop'],
    ['missing hook_event_name', { ...common }],
    ['empty hook_event_name', { hook_event_name: '' }],
    ['non-string hook_event_name', { hook_event_name: 42 }],
    ['non-string message', { hook_event_name: 'Notification', message: 5, notification_type: 'permission_prompt' }],
    ['object message', { hook_event_name: 'Notification', message: { text: 'x' } }],
    ['non-string notification_type', { hook_event_name: 'Notification', notification_type: ['permission_prompt'] }],
  ])('rejects %s', (_label, raw) => {
    expect(parseHookEvent(raw)).toBeNull();
  });

  it('treats an explicit null message or notification_type as absent', () => {
    expect(parseHookEvent({ hook_event_name: 'Notification', message: null, notification_type: null }))
      .toEqual({ hookEventName: 'Notification', notificationType: null, message: null });
  });
});

describe('classifyHookEvent', () => {
  const notif = (notificationType: string | null) => ({ hookEventName: 'Notification', notificationType, message: 'm' });

  it.each(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'])(
    'Notification/%s is needs-input (AC1)',
    (type) => { expect(classifyHookEvent(notif(type))).toBe('needs-input'); },
  );

  it.each([
    'idle_prompt', 'auth_success', 'elicitation_complete', 'elicitation_response', 'agent_completed',
    'quota_auto_resume_fired', 'quota_auto_resume_stale', 'quota_auto_resume_disabled', 'some_future_type',
  ])('Notification/%s is ignored (AC3)', (type) => {
    expect(classifyHookEvent(notif(type))).toBe('ignored');
  });

  it('Notification without a notification_type is ignored', () => {
    expect(classifyHookEvent(notif(null))).toBe('ignored');
  });

  it('Stop is finished (AC2)', () => {
    expect(classifyHookEvent({ hookEventName: 'Stop', notificationType: null, message: null })).toBe('finished');
  });

  it.each(['SubagentStop', 'UserPromptSubmit', 'SessionEnd', 'PreToolUse', 'stop'])('%s is ignored (AC3)', (name) => {
    expect(classifyHookEvent({ hookEventName: name, notificationType: null, message: null })).toBe('ignored');
  });

  it('notification_type only counts on a Notification event', () => {
    expect(classifyHookEvent({ hookEventName: 'Stop', notificationType: 'permission_prompt', message: null })).toBe('finished');
    expect(classifyHookEvent({ hookEventName: 'PreToolUse', notificationType: 'permission_prompt', message: null })).toBe('ignored');
  });

  it('the needs-input set is exactly the four documented blocking types', () => {
    expect([...NEEDS_INPUT_TYPES].sort()).toEqual(['agent_needs_input', 'elicitation_dialog', 'elicitation_url_dialog', 'permission_prompt']);
  });
});

describe('stateTransitionFor (spec transition table)', () => {
  const ev = (hookEventName: string, notificationType: string | null = null): HookEvent => ({ hookEventName, notificationType, message: null });

  it('UserPromptSubmit → busy (AC2)', () => {
    expect(stateTransitionFor(ev('UserPromptSubmit'))).toBe('busy');
  });

  it.each(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])('%s → busy (AC3)', (name) => {
    expect(stateTransitionFor(ev(name))).toBe('busy');
  });

  it('PermissionRequest → blocked (AC4)', () => {
    expect(stateTransitionFor(ev('PermissionRequest'))).toBe('blocked');
  });

  it.each(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'])('Notification/%s → blocked (AC4)', (type) => {
    expect(stateTransitionFor(ev('Notification', type))).toBe('blocked');
  });

  it.each(['Stop', 'StopFailure'])('%s → idle (AC6)', (name) => {
    expect(stateTransitionFor(ev(name))).toBe('idle');
  });

  it('Notification/idle_prompt → idle (AC6)', () => {
    expect(stateTransitionFor(ev('Notification', 'idle_prompt'))).toBe('idle');
  });

  it.each([
    ['Notification', 'auth_success'], ['Notification', 'elicitation_complete'], ['Notification', 'agent_completed'],
    ['Notification', 'some_future_type'], ['Notification', null],
    ['PermissionDenied', null], ['SubagentStop', null], ['SessionEnd', null], ['SomeFutureEvent', null],
    ['stop', null], ['pretooluse', null],
  ])('%s/%s leaves the state unchanged (AC5)', (name, type) => {
    expect(stateTransitionFor(ev(name, type))).toBeNull();
  });

  it('notification_type only counts on a Notification event', () => {
    expect(stateTransitionFor(ev('SubagentStop', 'permission_prompt'))).toBeNull();
    expect(stateTransitionFor(ev('PermissionDenied', 'idle_prompt'))).toBeNull();
    expect(stateTransitionFor(ev('Stop', 'permission_prompt'))).toBe('idle');
  });

  it('does not treat inherited object keys as events', () => {
    expect(stateTransitionFor(ev('constructor'))).toBeNull();
    expect(stateTransitionFor(ev('toString'))).toBeNull();
    expect(stateTransitionFor(ev('__proto__'))).toBeNull();
  });
});
