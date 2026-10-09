import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ICON_SIZE } from '@renderer/components/icon-size';
import { PlusIcon, SplitIcon, StarFilledIcon, StarIcon, XIcon } from '@renderer/components/shell-icons';

function svgAttrs(markup: string): { width?: string; height?: string; stroke?: string } {
  const tag = /<svg\b[^>]*>/.exec(markup)?.[0] ?? '';
  const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
  return { width: attr('width'), height: attr('height'), stroke: attr('stroke-width') };
}

describe('shared shell icons', () => {
  it('XIcon defaults to 10 px with stroke 2.5', () => {
    expect(svgAttrs(renderToStaticMarkup(<XIcon />))).toEqual({ width: '10', height: '10', stroke: '2.5' });
  });

  it('XIcon at sm and md is drawn at that size with stroke 2', () => {
    expect(svgAttrs(renderToStaticMarkup(<XIcon size={ICON_SIZE.sm} />))).toEqual({ width: '12', height: '12', stroke: '2' });
    expect(svgAttrs(renderToStaticMarkup(<XIcon size={ICON_SIZE.md} />))).toEqual({ width: '14', height: '14', stroke: '2' });
  });

  it('PlusIcon defaults to 14 px and takes a size, always stroke 2', () => {
    expect(svgAttrs(renderToStaticMarkup(<PlusIcon />))).toEqual({ width: '14', height: '14', stroke: '2' });
    expect(svgAttrs(renderToStaticMarkup(<PlusIcon size={ICON_SIZE.sm} />))).toEqual({ width: '12', height: '12', stroke: '2' });
  });

  it('SplitIcon defaults to 14 px with stroke 2', () => {
    expect(svgAttrs(renderToStaticMarkup(<SplitIcon />))).toEqual({ width: '14', height: '14', stroke: '2' });
  });

  it('StarIcon is 12 px stroke 2; StarFilledIcon is 12 px and keeps stroke 1.5', () => {
    expect(svgAttrs(renderToStaticMarkup(<StarIcon />))).toEqual({ width: '12', height: '12', stroke: '2' });
    expect(svgAttrs(renderToStaticMarkup(<StarFilledIcon />))).toEqual({ width: '12', height: '12', stroke: '1.5' });
  });
});
