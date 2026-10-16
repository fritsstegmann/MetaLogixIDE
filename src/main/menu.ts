/** Builds the native application menu from the pure per-platform template in `menu-template.ts`. */
import { Menu } from 'electron';
import type { BrowserWindow } from 'electron';
import { buildMenuTemplate } from './menu-template';

/** The app menu for the running platform; `mainWindow` is accepted for the existing call site only. */
export function buildAppMenu(mainWindow: BrowserWindow | null): Menu {
  void mainWindow;
  return Menu.buildFromTemplate(buildMenuTemplate(process.platform === 'darwin'));
}
