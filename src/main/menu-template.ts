/** Pure, per-platform native menu template; `menu.ts` builds the Electron menu from it. */
import type { MenuItemConstructorOptions } from 'electron';

export type BuildMenuTemplateFn = (isMac: boolean) => MenuItemConstructorOptions[];

export const buildMenuTemplate: BuildMenuTemplateFn = () => {
  throw new Error('not implemented');
};
