/**
 * Pure, per-platform native menu template; `menu.ts` builds the Electron menu from it. Electron is
 * imported for types only so vitest can load this file. On non-mac, Reload and Minimize are plain
 * click items with no role and no accelerator: their role defaults (Ctrl+R, Ctrl+M) collide with
 * shell keys, and a role item without an explicit accelerator would inherit them. Mac keeps the
 * roles, so Cmd+R and Cmd+M still work there.
 */
import type { BaseWindow, MenuItemConstructorOptions } from 'electron';

export type BuildMenuTemplateFn = (isMac: boolean) => MenuItemConstructorOptions[];

interface Reloadable {
  readonly webContents: { reload(): void };
}

const hasWebContents = (win: BaseWindow | undefined): win is BaseWindow & Reloadable =>
  win !== undefined && 'webContents' in win;

const APP_MENU: MenuItemConstructorOptions = {
  label: 'MetaLogix IDE',
  submenu: [
    { role: 'about', label: 'About MetaLogix IDE' },
    { type: 'separator' },
    { label: 'Settings…', accelerator: 'CmdOrCtrl+,', enabled: false },
    { type: 'separator' },
    { role: 'services' },
    { type: 'separator' },
    { role: 'hide', label: 'Hide MetaLogix IDE' },
    { role: 'hideOthers' },
    { role: 'unhide', label: 'Show All' },
    { type: 'separator' },
    { role: 'quit', label: 'Quit MetaLogix IDE' },
  ],
};

const EDIT_MENU: MenuItemConstructorOptions = {
  label: 'Edit',
  submenu: [
    { role: 'undo' },
    { role: 'redo' },
    { type: 'separator' },
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { role: 'selectAll' },
  ],
};

const HELP_MENU: MenuItemConstructorOptions = {
  role: 'help',
  submenu: [{ label: 'MetaLogix IDE Help', enabled: false }],
};

const RELOAD: Record<'mac' | 'other', MenuItemConstructorOptions> = {
  mac: { role: 'reload', accelerator: 'CmdOrCtrl+R' },
  other: {
    label: 'Reload',
    click: (_item, win) => {
      if (hasWebContents(win)) win.webContents.reload();
    },
  },
};

const MINIMIZE: Record<'mac' | 'other', MenuItemConstructorOptions> = {
  mac: { role: 'minimize' },
  other: { label: 'Minimize', click: (_item, win) => win?.minimize() },
};

function fileMenu(isMac: boolean): MenuItemConstructorOptions {
  return {
    label: 'File',
    submenu: [
      { label: 'New Window', accelerator: 'CmdOrCtrl+N', enabled: false },
      isMac ? { role: 'close', label: 'Close Window' } : { role: 'quit', label: 'Close Window' },
    ],
  };
}

function windowMenu(isMac: boolean): MenuItemConstructorOptions {
  const macExtras: MenuItemConstructorOptions[] = isMac
    ? [{ type: 'separator' }, { role: 'front' }]
    : [];
  return {
    label: 'Window',
    submenu: [MINIMIZE[isMac ? 'mac' : 'other'], { role: 'zoom' }, ...macExtras],
  };
}

export const buildMenuTemplate: BuildMenuTemplateFn = (isMac) => [
  ...(isMac ? [APP_MENU] : []),
  fileMenu(isMac),
  EDIT_MENU,
  {
    label: 'View',
    submenu: [RELOAD[isMac ? 'mac' : 'other'], { type: 'separator' }, { role: 'togglefullscreen' }],
  },
  windowMenu(isMac),
  HELP_MENU,
];
