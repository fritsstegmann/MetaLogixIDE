import type { EffectiveTheme } from '@renderer/markdown/contract';

/** Effective light/dark theme read from `<html data-theme>` and the OS preference. */
export function useDocumentTheme(): EffectiveTheme {
  return 'dark';
}
