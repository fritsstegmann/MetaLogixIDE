/**
 * Applies the synchronized UI family through the renderer's single CSS custom property.
 */

import { useEffect } from 'react';
import { UI_FONT_FALLBACK } from '@shared/font-settings';
import { UI_FONT_CSS_PROPERTY } from './font-contract';
import { useFontSettings } from './font-settings-context';
import { buildFontFamilyStack } from './font-family';

/** Keeps the document UI font property synchronized without injecting stylesheet text. */
export function useApplyUiFont(): void {
  const { uiFontFamily } = useFontSettings();

  useEffect(() => {
    const style = document.documentElement.style;
    if (uiFontFamily === null) {
      style.removeProperty(UI_FONT_CSS_PROPERTY);
      return;
    }
    style.setProperty(
      UI_FONT_CSS_PROPERTY,
      buildFontFamilyStack(uiFontFamily, UI_FONT_FALLBACK),
    );
    return () => {
      style.removeProperty(UI_FONT_CSS_PROPERTY);
    };
  }, [uiFontFamily]);
}
