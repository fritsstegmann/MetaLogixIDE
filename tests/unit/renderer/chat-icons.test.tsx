import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ChatBubbleIcon,
  CloseIcon,
  DeleteIcon,
  DownloadIcon,
  EditIcon,
  EmptyChannelIcon,
  FileIcon,
  FolderOpenIcon,
  LinkPlugIcon,
} from '@renderer/components/chat-icons';

function svgAttrs(markup: string): { width?: string; height?: string; stroke?: string } {
  const tag = /<svg\b[^>]*>/.exec(markup)?.[0] ?? '';
  const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
  return { width: attr('width'), height: attr('height'), stroke: attr('stroke-width') };
}

describe('chat icons', () => {
  it('LinkPlugIcon is 14 px stroke 2', () => {
    expect(svgAttrs(renderToStaticMarkup(<LinkPlugIcon />))).toEqual({ width: '14', height: '14', stroke: '2' });
  });

  it('ChatBubbleIcon is 20 px stroke 2', () => {
    expect(svgAttrs(renderToStaticMarkup(<ChatBubbleIcon />))).toEqual({ width: '20', height: '20', stroke: '2' });
  });

  it('CloseIcon is 14 px stroke 2', () => {
    expect(svgAttrs(renderToStaticMarkup(<CloseIcon />))).toEqual({ width: '14', height: '14', stroke: '2' });
  });

  it('EmptyChannelIcon is 20 px stroke 2', () => {
    expect(svgAttrs(renderToStaticMarkup(<EmptyChannelIcon />))).toEqual({ width: '20', height: '20', stroke: '2' });
  });

  it('EditIcon and DeleteIcon are 12 px stroke 2', () => {
    expect(svgAttrs(renderToStaticMarkup(<EditIcon />))).toEqual({ width: '12', height: '12', stroke: '2' });
    expect(svgAttrs(renderToStaticMarkup(<DeleteIcon />))).toEqual({ width: '12', height: '12', stroke: '2' });
  });

  it('FileIcon is 14 px stroke 2', () => {
    expect(svgAttrs(renderToStaticMarkup(<FileIcon />))).toEqual({ width: '14', height: '14', stroke: '2' });
  });

  it('DownloadIcon and FolderOpenIcon are 12 px stroke 2', () => {
    expect(svgAttrs(renderToStaticMarkup(<DownloadIcon />))).toEqual({ width: '12', height: '12', stroke: '2' });
    expect(svgAttrs(renderToStaticMarkup(<FolderOpenIcon />))).toEqual({ width: '12', height: '12', stroke: '2' });
  });
});
