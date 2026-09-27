import { describe, it, expect, vi } from 'vitest';
import { createMaterialController, type MaterialControllerDeps, type MaterialWindow } from '@main/windows/material-controller';
import { MATERIAL_QUERY_PARAM, parseMaterialQuery, type WindowMaterial } from '@shared/window-material';

const INITIAL: WindowMaterial = { opacity: 80, blur: 20, saturation: 180 };
const CHANGED: WindowMaterial = { opacity: 50, blur: 8, saturation: 120 };

function fakeWindow(destroyed = false): MaterialWindow & { setOpacity: ReturnType<typeof vi.fn> } {
  return { setOpacity: vi.fn(), isDestroyed: () => destroyed };
}

function build(overrides: Partial<MaterialControllerDeps> = {}, windows: MaterialWindow[] = []) {
  let reduced = false;
  const deps: MaterialControllerDeps = {
    platform: 'win32',
    getReducedTransparency: () => reduced,
    listWindows: () => [...windows],
    initial: INITIAL,
    ...overrides,
  };
  return { controller: createMaterialController(deps), setReduced: (v: boolean) => { reduced = v; } };
}

describe('createMaterialController', () => {
  it('starts with the injected initial material', () => {
    expect(build().controller.current()).toEqual(INITIAL);
  });

  it('apply stores the material and sets native opacity on every live window, skipping destroyed ones', () => {
    const live1 = fakeWindow();
    const live2 = fakeWindow();
    const dead = fakeWindow(true);
    const { controller } = build({}, [live1, dead, live2]);
    controller.apply(CHANGED);
    expect(controller.current()).toEqual(CHANGED);
    expect(live1.setOpacity).toHaveBeenCalledWith(0.5);
    expect(live2.setOpacity).toHaveBeenCalledWith(0.5);
    expect(dead.setOpacity).not.toHaveBeenCalled();
  });

  it('apply lists windows at call time, so windows opened later are included', () => {
    const windows: MaterialWindow[] = [];
    const { controller } = build({}, windows);
    const late = fakeWindow();
    windows.push(late);
    controller.apply(CHANGED);
    expect(late.setOpacity).toHaveBeenCalledWith(0.5);
  });

  it('on darwin never sets a native opacity other than 1', () => {
    const win = fakeWindow();
    const { controller } = build({ platform: 'darwin' }, [win]);
    controller.apply({ ...CHANGED, opacity: 30 });
    controller.prepareNewWindow(win);
    controller.onReducedTransparencyChanged();
    for (const [value] of win.setOpacity.mock.calls) expect(value).toBe(1);
  });

  it('prepareNewWindow applies the initial material to a new window', () => {
    const win = fakeWindow();
    build().controller.prepareNewWindow(win);
    expect(win.setOpacity).toHaveBeenCalledWith(0.8);
  });

  it('prepareNewWindow applies the current material after a change (popout-after-change, AC7)', () => {
    const { controller } = build();
    controller.apply(CHANGED);
    const popout = fakeWindow();
    controller.prepareNewWindow(popout);
    expect(popout.setOpacity).toHaveBeenCalledTimes(1);
    expect(popout.setOpacity).toHaveBeenCalledWith(0.5);
  });

  it('prepareNewWindow skips a destroyed window', () => {
    const win = fakeWindow(true);
    build().controller.prepareNewWindow(win);
    expect(win.setOpacity).not.toHaveBeenCalled();
  });

  it('prepareNewWindow forces native opacity 1 under reduced transparency', () => {
    const { controller, setReduced } = build();
    setReduced(true);
    const win = fakeWindow();
    controller.prepareNewWindow(win);
    expect(win.setOpacity).toHaveBeenCalledWith(1);
  });

  it.each([
    ['darwin', 0.8],
    ['linux', 1],
  ])('queryString on %s carries the initial render values', (platform, alpha) => {
    const q = build({ platform }).controller.queryString();
    expect(q.startsWith(`${MATERIAL_QUERY_PARAM}=`)).toBe(true);
    expect(parseMaterialQuery(`?${q}`)).toEqual({ surfaceAlpha: alpha, blurPx: 20, saturatePct: 180 });
  });

  it('queryString reflects the current material after apply', () => {
    const { controller } = build({ platform: 'darwin' });
    controller.apply(CHANGED);
    expect(parseMaterialQuery(`?popout=1&${controller.queryString()}`)).toEqual({ surfaceAlpha: 0.5, blurPx: 8, saturatePct: 120 });
  });

  it('onReducedTransparencyChanged re-applies native opacity to every live window (AC11)', () => {
    const win = fakeWindow();
    const { controller, setReduced } = build({}, [win]);
    setReduced(true);
    controller.onReducedTransparencyChanged();
    expect(win.setOpacity).toHaveBeenLastCalledWith(1);
    setReduced(false);
    controller.onReducedTransparencyChanged();
    expect(win.setOpacity).toHaveBeenLastCalledWith(0.8);
  });

  it('onReducedTransparencyChanged works when detached from the controller (used as an event listener)', () => {
    const win = fakeWindow();
    const { controller } = build({}, [win]);
    const listener = controller.onReducedTransparencyChanged;
    listener();
    expect(win.setOpacity).toHaveBeenCalledWith(0.8);
  });
});
