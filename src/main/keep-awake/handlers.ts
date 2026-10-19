/**
 * IPC handlers for the macOS keep-awake timer. STUB from the setup pass:
 * Agent 1 replaces the bodies. Expected failures come back as result values.
 */
import type { Handler } from '@main/ipc/register';

type KeepAwakeChannel = 'keep-awake:get' | 'keep-awake:start' | 'keep-awake:stop' | 'keep-awake:darken';

/** IPC handlers for the keep-awake timer. */
export const keepAwakeHandlers: { [C in KeepAwakeChannel]: Handler<C> } = {
  'keep-awake:get': async () => {
    throw new Error('not implemented');
  },
  'keep-awake:start': async () => {
    throw new Error('not implemented');
  },
  'keep-awake:stop': async () => {
    throw new Error('not implemented');
  },
  'keep-awake:darken': async () => {
    throw new Error('not implemented');
  },
};
