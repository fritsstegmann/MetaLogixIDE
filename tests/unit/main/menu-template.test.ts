import { describe, it, expect, vi } from 'vitest';
import type { BaseWindow, MenuItemConstructorOptions } from 'electron';
import { buildMenuTemplate } from '@main/menu-template';

/** Roles Electron gives a default accelerator on Linux (lib/browser/api/menu-item-roles.ts @ v32). */
const ROLES_WITH_LINUX_DEFAULT_ACCELERATOR = new Set([
  'close',
  'copy',
  'cut',
  'paste',
  'minimize',
  'quit',
  'redo',
  'reload',
  'forcereload',
  'selectall',
  'togglefullscreen',
  'undo',
  'toggledevtools',
  'resetzoom',
  'zoomin',
  'zoomout',
]);

function flatten(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flatten(item.submenu) : []),
  ]);
}

function submenu(
  template: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions[] {
  const menu = template.find((m) => m.label === label);
  if (!menu || !Array.isArray(menu.submenu)) throw new Error(`no ${label} menu`);
  return menu.submenu;
}

const item = (
  items: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions | undefined => items.find((i) => i.label === label);

const roleOf = (i: MenuItemConstructorOptions): string | undefined => i.role?.toLowerCase();

/** Every item that fires on a key: explicit accelerator, or a role carrying a default one. */
function acceleratorBearers(template: MenuItemConstructorOptions[]): string[] {
  return flatten(template)
    .filter(
      (i) =>
        i.accelerator !== undefined || ROLES_WITH_LINUX_DEFAULT_ACCELERATOR.has(roleOf(i) ?? ''),
    )
    .map((i) => `${i.role ?? i.label}:${String(i.accelerator ?? 'role-default')}`);
}

describe('buildMenuTemplate on non-mac (AC19)', () => {
  const template = buildMenuTemplate(false);

  it('keeps a Reload item in View with no accelerator and no reload role', () => {
    const reload = item(submenu(template, 'View'), 'Reload');
    expect(reload).toBeDefined();
    expect(reload?.accelerator).toBeUndefined();
    expect(reload?.role).toBeUndefined();
  });

  it('keeps a Minimize item in Window with no accelerator and no minimize role', () => {
    const minimize = item(submenu(template, 'Window'), 'Minimize');
    expect(minimize).toBeDefined();
    expect(minimize?.accelerator).toBeUndefined();
    expect(minimize?.role).toBeUndefined();
  });

  it('has no reload or minimize role anywhere', () => {
    const roles = flatten(template).map(roleOf);
    expect(roles).not.toContain('reload');
    expect(roles).not.toContain('forcereload');
    expect(roles).not.toContain('minimize');
  });

  it('Reload reloads the clicked window and Minimize minimises it', () => {
    const reload = vi.fn();
    const minimize = vi.fn();
    const win = { webContents: { reload }, minimize } as unknown as BaseWindow;
    item(submenu(template, 'View'), 'Reload')?.click?.(undefined as never, win, undefined as never);
    item(submenu(template, 'Window'), 'Minimize')?.click?.(
      undefined as never,
      win,
      undefined as never,
    );
    expect(reload).toHaveBeenCalledTimes(1);
    expect(minimize).toHaveBeenCalledTimes(1);
  });

  it('Reload and Minimize do nothing without a window', () => {
    expect(() =>
      item(submenu(template, 'View'), 'Reload')?.click?.(
        undefined as never,
        undefined,
        undefined as never,
      ),
    ).not.toThrow();
    expect(() =>
      item(submenu(template, 'Window'), 'Minimize')?.click?.(
        undefined as never,
        undefined,
        undefined as never,
      ),
    ).not.toThrow();
  });

  it('keeps undo, redo and select-all on their roles', () => {
    const roles = submenu(template, 'Edit').map(roleOf);
    expect(roles).toEqual(expect.arrayContaining(['undo', 'redo', 'selectall']));
    for (const i of submenu(template, 'Edit')) expect(i.accelerator).toBeUndefined();
  });

  it('gains no accelerator: the full list of key-bearing items is exactly today minus Reload and Minimize', () => {
    expect(acceleratorBearers(template)).toEqual([
      'New Window:CmdOrCtrl+N',
      'quit:role-default',
      'undo:role-default',
      'redo:role-default',
      'cut:role-default',
      'copy:role-default',
      'paste:role-default',
      'selectAll:role-default',
      'togglefullscreen:role-default',
    ]);
  });

  it('has no mac-only app menu', () => {
    expect(template.map((m) => m.label ?? m.role)).toEqual([
      'File',
      'Edit',
      'View',
      'Window',
      'help',
    ]);
  });
});

describe('buildMenuTemplate on mac (AC19)', () => {
  const template = buildMenuTemplate(true);

  it('keeps Reload on its role with Cmd+R', () => {
    const reload = submenu(template, 'View').find((i) => i.role === 'reload');
    expect(reload?.accelerator).toBe('CmdOrCtrl+R');
  });

  it('keeps Minimize on its role (Cmd+M)', () => {
    expect(submenu(template, 'Window').some((i) => i.role === 'minimize')).toBe(true);
  });

  it('keeps the app menu, close role and front item', () => {
    expect(template[0]?.label).toBe('MetaLogix IDE');
    expect(submenu(template, 'File').some((i) => i.role === 'close')).toBe(true);
    expect(submenu(template, 'Window').some((i) => i.role === 'front')).toBe(true);
  });
});
