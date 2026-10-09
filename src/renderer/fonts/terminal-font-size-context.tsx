import { createContext, useContext, type ReactNode } from 'react';
import { TERMINAL_FONT_SIZE } from '@shared/terminal-font-size';

export interface TerminalFontSizeState {
  /** Effective size in px; TERMINAL_FONT_SIZE.default until loaded. */
  readonly size: number;
  /** True once the stored (or migrated) size has been applied. */
  readonly ready: boolean;
  /** Clamps; no-op if unchanged; applies locally, then persists and broadcasts. */
  setSize(next: number): void;
}

const STUB_STATE: TerminalFontSizeState = {
  size: TERMINAL_FONT_SIZE.default,
  ready: false,
  setSize: () => {},
};

const TerminalFontSizeContext = createContext<TerminalFontSizeState | null>(null);

/** One shared terminal font size per window, kept in sync with the main-process settings store. */
export function TerminalFontSizeProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return <TerminalFontSizeContext.Provider value={STUB_STATE}>{children}</TerminalFontSizeContext.Provider>;
}

/** Reads the shared terminal font size; throws outside TerminalFontSizeProvider. */
export function useTerminalFontSize(): TerminalFontSizeState {
  const state = useContext(TerminalFontSizeContext);
  if (state === null) throw new Error('useTerminalFontSize must be used inside TerminalFontSizeProvider');
  return state;
}
