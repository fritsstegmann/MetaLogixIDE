import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PresenceContext } from 'motion/react';
import { ContextMenu } from '@renderer/components/ContextMenu';
import { menuMotion } from '@renderer/menu-motion';
import { MENU_EASE, MENU_ENTER_S, MENU_EXIT_S, MENU_FADE_MIN_S, MENU_SCALE_FROM } from '@renderer/motion-tokens';

describe('menuMotion (normal)', () => {
  const m = menuMotion(false);

  it('enters from faded and slightly scaled, no further than 0.95', () => {
    expect(m.initial).toEqual({ opacity: 0, scale: MENU_SCALE_FROM });
    expect(MENU_SCALE_FROM).toBeGreaterThanOrEqual(0.95);
  });

  it('rests at opacity 1 and scale 1 so no transform remains', () => {
    expect(m.animate).toMatchObject({ opacity: 1, scale: 1 });
  });

  it('exits back to the entry state', () => {
    expect(m.exit).toMatchObject({ opacity: 0, scale: MENU_SCALE_FROM });
  });

  it('keeps enter and exit within 200ms', () => {
    expect(m.animate.transition.duration).toBe(MENU_ENTER_S);
    expect(m.exit.transition.duration).toBe(MENU_EXIT_S);
    expect(MENU_ENTER_S).toBeLessThanOrEqual(0.2);
    expect(MENU_EXIT_S).toBeLessThanOrEqual(0.2);
  });
});

describe('menuMotion (reduced)', () => {
  const m = menuMotion(true);

  it('never scales', () => {
    expect(m.initial).toEqual({ opacity: 0 });
    expect(m.animate).not.toHaveProperty('scale');
    expect(m.exit).not.toHaveProperty('scale');
  });

  it('fades evenly, not with the front-loaded menu curve, so the fade is perceptibly >=150ms', () => {
    expect(m.animate.transition.ease).toBe('linear');
    expect(m.exit.transition.ease).toBe('linear');
  });

  it('keeps the menu curve for normal motion', () => {
    expect(menuMotion(false).animate.transition.ease).toBe(MENU_EASE);
  });

  it('fades for at least 150ms both ways', () => {
    expect(m.animate.transition.duration).toBe(MENU_FADE_MIN_S);
    expect(m.exit.transition.duration).toBe(MENU_FADE_MIN_S);
    expect(MENU_FADE_MIN_S).toBeGreaterThanOrEqual(0.15);
  });
});

describe('ContextMenu presence', () => {
  const items = [{ label: 'Open', onClick: () => undefined }];
  const render = (isPresent: boolean): string =>
    renderToStaticMarkup(
      createElement(
        PresenceContext.Provider,
        { value: { id: 'x', isPresent, initial: false, custom: undefined, onExitComplete: () => undefined, register: () => () => undefined } },
        createElement(ContextMenu, { x: 10, y: 20, items, onClose: () => undefined }),
      ),
    );

  it('present: backdrop, menu role and test id', () => {
    const html = render(true);
    expect(html).toContain('fixed inset-0 z-40');
    expect(html).toContain('role="menu"');
    expect(html).toContain('data-testid="context-menu"');
    expect(html).not.toContain('pointer-events-none');
  });

  it('leaving: no backdrop, inert panel, renamed, role dropped', () => {
    const html = render(false);
    expect(html).not.toContain('fixed inset-0 z-40');
    expect(html).toContain('pointer-events-none');
    expect(html).toContain('data-testid="context-menu-leaving"');
    expect(html).not.toContain('data-testid="context-menu"');
    expect(html).not.toContain('role="menu"');
  });

  it('drops the css popover class so the entry is not doubled', () => {
    expect(render(true)).not.toContain('popover');
  });

  it('keeps position and transform origin inline', () => {
    expect(render(true)).toMatch(/left:10px;top:20px;transform-origin:0px 0px/);
  });
});
