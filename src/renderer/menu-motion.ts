import { MENU_EASE, MENU_ENTER_S, MENU_EXIT_S, MENU_FADE_MIN_S, MENU_SCALE_FROM } from './motion-tokens';

type MenuTransition = { duration: number; ease: typeof MENU_EASE | 'linear' };
type MenuState = { opacity: number; scale?: number };

export type MenuMotion = {
  initial: MenuState;
  animate: MenuState & { transition: MenuTransition };
  exit: MenuState & { transition: MenuTransition };
};

/**
 * Enter/exit props for a menu root `m.div`: opacity plus a small scale in
 * normal motion; under `reduced` an opacity-only fade of at least
 * `MENU_FADE_MIN_S`. The resting state is opacity 1 and scale 1, so no
 * transform remains once open.
 */
export function menuMotion(reduced: boolean): MenuMotion {
  if (reduced) {
    const fade = { duration: MENU_FADE_MIN_S, ease: 'linear' } as const;
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1, transition: fade },
      exit: { opacity: 0, transition: fade },
    };
  }
  const enter = { duration: MENU_ENTER_S, ease: MENU_EASE };
  const leave = { duration: MENU_EXIT_S, ease: MENU_EASE };
  return {
    initial: { opacity: 0, scale: MENU_SCALE_FROM },
    animate: { opacity: 1, scale: 1, transition: enter },
    exit: { opacity: 0, scale: MENU_SCALE_FROM, transition: leave },
  };
}
