/**
 * Typed view of a Claude Code hook POST body, its parser and its classifier.
 * Single home of the needs-input `notification_type` set (spec risk
 * "payload drift").
 */

/** The subset of a Claude Code hook input the app uses; every other field is dropped at parse time. */
export interface HookEvent {
  hookEventName: string;
  notificationType: string | null;
  message: string | null;
}

/** What a hook event means for notifications. */
export type HookEventKind = 'needs-input' | 'finished' | 'ignored';

/** `Notification` types that mean Claude is blocked on the user (spec Definitions; AskUserQuestion arrives as `permission_prompt`). */
export const NEEDS_INPUT_TYPES: ReadonlySet<string> = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
]);

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parses an untrusted JSON value into a `HookEvent`. Returns null when the
 * value is not an object, `hook_event_name` is not a non-empty string, or
 * `message` / `notification_type` are present with a non-string value.
 */
export function parseHookEvent(raw: unknown): HookEvent | null {
  if (!isRecord(raw)) return null;
  const hookEventName = raw.hook_event_name;
  if (typeof hookEventName !== 'string' || hookEventName === '') return null;
  const notificationType = optionalString(raw.notification_type);
  const message = optionalString(raw.message);
  if (notificationType === undefined || message === undefined) return null;
  return { hookEventName, notificationType, message };
}

/** Maps an event to needs-input (blocking Notification), finished (`Stop`) or ignored (everything else). */
export function classifyHookEvent(event: HookEvent): HookEventKind {
  if (event.hookEventName === 'Stop') return 'finished';
  if (event.hookEventName !== 'Notification' || event.notificationType === null) return 'ignored';
  return NEEDS_INPUT_TYPES.has(event.notificationType) ? 'needs-input' : 'ignored';
}
