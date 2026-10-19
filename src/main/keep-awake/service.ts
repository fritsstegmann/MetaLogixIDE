/**
 * Keep-awake state machine over injected ports. It owns the invariants: one
 * power assertion, deadline range, one 1 s wall-clock tick while active,
 * a darken scheduled after each start, and expiry with a single notification.
 */
import {
  KEEP_AWAKE_COPY,
  KEEP_AWAKE_DARKEN_DELAY_MS,
  KEEP_AWAKE_MAX_MS,
  type KeepAwakeState,
} from '@shared/keep-awake-contract';
import type { Darken } from './darken';
import type { KeepAwakeController } from './port';
import type { PowerAssertion } from './power-assertion';

/** Timer functions, injectable for tests. */
export interface KeepAwakeTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Collaborators of the keep-awake service. */
export interface KeepAwakeDeps {
  assertion: PowerAssertion;
  darken: Darken;
  notify(title: string, body: string): void;
  now(): number;
  timers: KeepAwakeTimers;
  onChange(state: KeepAwakeState): void;
  onDarkenFailed(): void;
}

const TICK_MS = 1000;
const INACTIVE: KeepAwakeState = { active: false };

/** Creates the controller; all timers and the assertion are released by `stop`, expiry or `dispose`. */
export function createKeepAwakeService(deps: KeepAwakeDeps): KeepAwakeController {
  const { assertion, timers } = deps;
  let endsAt: number | null = null;
  let tick: unknown = null;
  let darkenTimer: unknown = null;

  const state = (): KeepAwakeState => (endsAt === null ? INACTIVE : { active: true, endsAt });

  const clearDarkenTimer = (): void => {
    if (darkenTimer === null) return;
    timers.clearTimeout(darkenTimer);
    darkenTimer = null;
  };

  const runDarken = (): void => {
    void deps.darken().then((result) => {
      if (!result.ok && endsAt !== null) deps.onDarkenFailed();
    });
  };

  const scheduleDarken = (): void => {
    clearDarkenTimer();
    darkenTimer = timers.setTimeout(() => {
      darkenTimer = null;
      runDarken();
    }, KEEP_AWAKE_DARKEN_DELAY_MS);
  };

  const teardown = (): void => {
    clearDarkenTimer();
    if (tick !== null) timers.clearInterval(tick);
    tick = null;
    endsAt = null;
    assertion.release();
  };

  const expire = (): void => {
    teardown();
    deps.onChange(INACTIVE);
    deps.notify(KEEP_AWAKE_COPY.notification.title, KEEP_AWAKE_COPY.notification.body);
  };

  const onTick = (): void => {
    if (endsAt !== null && deps.now() >= endsAt) expire();
  };

  return {
    get: state,
    start(requested) {
      const now = deps.now();
      if (!Number.isFinite(requested) || requested <= now || requested > now + KEEP_AWAKE_MAX_MS)
        return { ok: false, error: 'invalid' };
      endsAt = requested;
      assertion.hold();
      if (tick === null) tick = timers.setInterval(onTick, TICK_MS);
      scheduleDarken();
      deps.onChange(state());
      return { ok: true, state: state() };
    },
    stop() {
      if (endsAt === null) return INACTIVE;
      teardown();
      deps.onChange(INACTIVE);
      return INACTIVE;
    },
    darkenNow() {
      if (endsAt === null) return { ok: false, error: 'inactive' };
      runDarken();
      return { ok: true };
    },
    dispose() {
      teardown();
    },
  };
}
