/**
 * The pane fold's motion, as pure data. A folding pane animates only the `--fold` custom property
 * between 0 and 1 (its width is a calc() of that), so nothing near a terminal is clipped,
 * transformed or resized by motion itself. `custom` carries the flags sampled when the pane was
 * toggled: `instant` (keyboard toggles) jumps in one step, `reduced` fades in place with the
 * layout changing in one step — at the start of an enter and after the fade of an exit.
 */
import type { Variants } from 'motion/react';
import { PANE_EASE, PANE_ENTER_S, PANE_EXIT_S, REDUCED_FADE_S } from './motion-tokens';

/** Flags a fold is resolved with; passed through `custom` so an exiting pane sees them too. */
export interface FoldCustom {
  instant: boolean;
  reduced: boolean;
}

/** The three states a folding pane passes through. */
export type FoldPhase = 'initial' | 'enter' | 'exit';

interface Tween {
  duration: number;
  delay?: number;
  ease?: typeof PANE_EASE;
}

/** One resolved motion target: the fold, an optional opacity, and their transitions. */
export type FoldTarget = {
  '--fold': number;
  opacity?: number;
  transition: Tween | { '--fold': Tween; opacity: Tween };
};

/** Variant labels for the `initial`, `animate` and `exit` props. */
export const FOLD_LABELS = { initial: 'folded', enter: 'unfolded', exit: 'gone' } as const satisfies Record<FoldPhase, string>;

const STEP: Tween = { duration: 0 };
const FADE: Tween = { duration: REDUCED_FADE_S, ease: PANE_EASE };

function reducedTarget(phase: FoldPhase): FoldTarget {
  if (phase === 'initial') return { '--fold': 1, opacity: 0, transition: STEP };
  if (phase === 'enter') return { '--fold': 1, opacity: 1, transition: { '--fold': STEP, opacity: FADE } };
  return { '--fold': 0, opacity: 0, transition: { '--fold': { duration: 0, delay: REDUCED_FADE_S }, opacity: FADE } };
}

/** Resolves one phase of the fold for the given flags. */
export function paneFoldTarget(phase: FoldPhase, { instant, reduced }: FoldCustom): FoldTarget {
  if (instant) return { '--fold': phase === 'exit' ? 0 : 1, transition: STEP };
  if (reduced) return reducedTarget(phase);
  if (phase === 'initial') return { '--fold': 0, transition: STEP };
  if (phase === 'enter') return { '--fold': 1, transition: { duration: PANE_ENTER_S, ease: PANE_EASE } };
  return { '--fold': 0, transition: { duration: PANE_EXIT_S, ease: PANE_EASE } };
}

/** The fold's variants, keyed by FOLD_LABELS and resolved from `custom`. */
export const paneFoldVariants = {
  [FOLD_LABELS.initial]: (c: FoldCustom) => paneFoldTarget('initial', c),
  [FOLD_LABELS.enter]: (c: FoldCustom) => paneFoldTarget('enter', c),
  [FOLD_LABELS.exit]: (c: FoldCustom) => paneFoldTarget('exit', c),
} satisfies Variants;
