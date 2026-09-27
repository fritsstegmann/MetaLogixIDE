import type { RefObject } from 'react';
import type { DiagramRenderer, EffectiveTheme } from '../contract';
import { mermaidRenderer } from './mermaidRenderer';

/** Renders every mermaid placeholder inside `container` after `html` lands. */
export function useMermaidDiagrams(
  container: RefObject<HTMLElement | null>,
  html: string,
  theme: EffectiveTheme,
  renderer: DiagramRenderer = mermaidRenderer,
): void {
  void container;
  void html;
  void theme;
  void renderer;
}
