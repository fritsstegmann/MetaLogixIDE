/** Platform modifier matching: ⌘ (without Ctrl) on mac, Ctrl (without Super) elsewhere. */
import type { IsPrimaryModFn } from './shortcut-contract';

export const isPrimaryMod: IsPrimaryModFn = () => {
  throw new Error('not implemented');
};
