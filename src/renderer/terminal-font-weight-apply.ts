/** Builds the xterm weight options from the shared terminal font weight; terminal construction and live update both use it so the normal/bold pair can never diverge. */
import { terminalBoldWeight, type TerminalFontWeight } from '@shared/terminal-font-weight';

export interface TerminalFontWeightOptions {
  readonly fontWeight: TerminalFontWeight;
  readonly fontWeightBold: TerminalFontWeight;
}

/** Returns `fontWeight` = `weight` and `fontWeightBold` = min(max(weight + 200, 700), 900), as numbers xterm accepts. */
export function terminalFontWeightOptions(weight: TerminalFontWeight): TerminalFontWeightOptions {
  return { fontWeight: weight, fontWeightBold: terminalBoldWeight(weight) };
}
