import { createElement } from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ErrorIcon, InfoIcon, mergeToasts, SuccessIcon, WarnIcon } from '@renderer/components/ToastStack';
import { XIcon } from '@renderer/components/shell-icons';
import { ICON_SIZE } from '@renderer/components/icon-size';
import type { Toast } from '@renderer/hooks/useToasts';

const t = (id: number): Toast => ({ id, kind: 'info', title: `t${id}`, timeoutMs: 0 });

function svgAttrs(markup: string): { width?: string; height?: string; stroke?: string } {
  const tag = /<svg\b[^>]*>/.exec(markup)?.[0] ?? '';
  const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
  return { width: attr('width'), height: attr('height'), stroke: attr('stroke-width') };
}

describe('mergeToasts', () => {
  it('adds new toasts in front, not leaving', () => {
    const out = mergeToasts([{ toast: t(1), leaving: false }], [t(2), t(1)]);
    expect(out.map((e) => [e.toast.id, e.leaving])).toEqual([[2, false], [1, false]]);
  });

  it('keeps a dismissed toast in place, marked leaving', () => {
    const rendered = [t(3), t(2), t(1)].map((toast) => ({ toast, leaving: false }));
    const out = mergeToasts(rendered, [t(3), t(1)]);
    expect(out.map((e) => [e.toast.id, e.leaving])).toEqual([[3, false], [2, true], [1, false]]);
  });

  it('leaves an already-leaving entry untouched', () => {
    const leaving = { toast: t(1), leaving: true };
    expect(mergeToasts([leaving], [])[0]).toBe(leaving);
  });

  it('returns nothing for an empty stack', () => {
    expect(mergeToasts([], [])).toEqual([]);
  });
});

describe('toast icons', () => {
  it('kind icons render at 14 px stroke 2', () => {
    expect(svgAttrs(renderToStaticMarkup(createElement(InfoIcon)))).toEqual({ width: '14', height: '14', stroke: '2' });
    expect(svgAttrs(renderToStaticMarkup(createElement(SuccessIcon)))).toEqual({ width: '14', height: '14', stroke: '2' });
    expect(svgAttrs(renderToStaticMarkup(createElement(WarnIcon)))).toEqual({ width: '14', height: '14', stroke: '2' });
    expect(svgAttrs(renderToStaticMarkup(createElement(ErrorIcon)))).toEqual({ width: '14', height: '14', stroke: '2' });
  });

  it('the dismiss button uses the shared X icon at 12 px stroke 2', () => {
    expect(svgAttrs(renderToStaticMarkup(createElement(XIcon, { size: ICON_SIZE.sm })))).toEqual({ width: '12', height: '12', stroke: '2' });
  });
});
