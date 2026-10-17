import type { Handler } from '@main/ipc/register';

type DropChannel = 'drops:resolve-app-file' | 'drops:stage-file' | 'drops:stage-clipboard-image';

/** IPC handlers for terminal drop and clipboard image paste. */
export const dropHandlers: { [C in DropChannel]: Handler<C> } = {
  'drops:resolve-app-file': async () => {
    throw new Error('not implemented');
  },
  'drops:stage-file': async () => {
    throw new Error('not implemented');
  },
  'drops:stage-clipboard-image': async () => {
    throw new Error('not implemented');
  },
};
