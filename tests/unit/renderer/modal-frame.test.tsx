import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModalFrame } from '@renderer/components/ModalFrame';
import { MODAL_CLASSES, MODAL_TIER_Z, scrimTestId, type ModalMotion, type ModalTier } from '@renderer/modal-glass';

interface Opening {
  tag: string;
  attrs: string;
  classes: string[];
  index: number;
}

function render(tier: ModalTier = 'modal', motion: ModalMotion = 'none', layerClassName?: string): string {
  return renderToStaticMarkup(
    <ModalFrame testId="demo" tier={tier} motion={motion} layerClassName={layerClassName} onDismiss={() => {}}>
      <div role="dialog" className="modal-sheet" data-testid="demo-panel">body</div>
    </ModalFrame>,
  );
}

function opening(html: string, testId: string): Opening {
  const re = new RegExp(`<(\\w+)([^>]*data-testid="${testId}"[^>]*)>`);
  const m = re.exec(html);
  if (!m?.[1] || m[2] === undefined) throw new Error(`no element ${testId} in ${html}`);
  const classes = /class="([^"]*)"/.exec(m[2])?.[1]?.split(/\s+/) ?? [];
  return { tag: m[1], attrs: m[2], classes, index: m.index };
}

/** Depth of every element at the point `index` in the markup (0 = top level). */
function depthAt(html: string, index: number): number {
  let depth = 0;
  const tag = /<(\/?)(\w+)[^>]*?(\/?)>/g;
  for (let m = tag.exec(html); m && m.index < index; m = tag.exec(html)) {
    if (m[3] === '/') continue;
    depth += m[1] === '/' ? -1 : 1;
  }
  return depth;
}

function zIndex(attrs: string): number {
  const m = /z-index:\s*(\d+)/.exec(attrs);
  if (!m?.[1]) throw new Error(`no z-index in ${attrs}`);
  return Number(m[1]);
}

describe('ModalFrame', () => {
  it('renders the scrim and the layer as top-level siblings, with the panel inside the layer', () => {
    const html = render();
    const scrim = opening(html, scrimTestId('demo'));
    const layer = opening(html, 'demo');
    const panel = opening(html, 'demo-panel');
    expect(depthAt(html, scrim.index)).toBe(0);
    expect(depthAt(html, layer.index)).toBe(0);
    expect(scrim.index).toBeLessThan(layer.index);
    expect(depthAt(html, panel.index)).toBe(1);
    expect(panel.index).toBeGreaterThan(layer.index);
    // The scrim is empty: it closes before the layer opens.
    expect(html.slice(scrim.index).startsWith(`<div${scrim.attrs}></div>`)).toBe(true);
  });

  it('puts the material class on the scrim and the pointer-transparent class on the layer', () => {
    const html = render();
    expect(opening(html, scrimTestId('demo')).classes).toContain(MODAL_CLASSES.scrim);
    expect(opening(html, 'demo').classes).toContain(MODAL_CLASSES.layer);
    expect(opening(html, 'demo').classes).not.toContain(MODAL_CLASSES.scrim);
  });

  it.each(['modal', 'palette', 'blocking'] as const)('stacks the %s tier at its z pair', (tier) => {
    const html = render(tier);
    expect(zIndex(opening(html, scrimTestId('demo')).attrs)).toBe(MODAL_TIER_Z[tier][0]);
    expect(zIndex(opening(html, 'demo').attrs)).toBe(MODAL_TIER_Z[tier][1]);
  });

  it('orders the tiers modal < palette < blocking', () => {
    expect(MODAL_TIER_Z.modal[1]).toBeLessThan(MODAL_TIER_Z.palette[0]);
    expect(MODAL_TIER_Z.palette[1]).toBeLessThan(MODAL_TIER_Z.blocking[0]);
  });

  it('adds the fade class to the scrim only when motion is fade', () => {
    expect(opening(render('modal', 'fade'), scrimTestId('demo')).classes).toContain(MODAL_CLASSES.fadeScrim);
    expect(opening(render('modal', 'none'), scrimTestId('demo')).classes).not.toContain(MODAL_CLASSES.fadeScrim);
  });

  it('keeps transform, filter, opacity and blur classes off the layer, even when the caller passes layout classes', () => {
    const layer = opening(render('modal', 'fade', 'flex items-start justify-center pt-[18vh]'), 'demo');
    expect(layer.classes).toEqual(expect.arrayContaining(['flex', 'items-start', 'justify-center', 'pt-[18vh]']));
    for (const c of layer.classes) {
      expect(c).not.toMatch(/^(transform|scale-|translate-|rotate-|filter|blur|backdrop-|opacity-|bg-black)/);
    }
    expect(layer.attrs).not.toMatch(/transform|filter|opacity/);
  });

  it('renders nothing but the two layers and the children', () => {
    const html = render();
    expect(html.match(/<div/g)).toHaveLength(3);
  });
});
