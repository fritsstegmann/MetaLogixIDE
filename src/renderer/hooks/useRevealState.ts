import type { RevealKey } from '@renderer/env-reveal';

export interface RevealState {
  isRevealed(key: RevealKey): boolean;
  toggle(key: RevealKey): void;
}

/** Per-row reveal state for one mounted editor; every value masks again on unmount (AC25). */
export function useRevealState(): RevealState {
  throw new Error('useRevealState not implemented');
}
