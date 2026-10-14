import type { ReactNode } from 'react';
import { MODAL_CLASSES, MODAL_TIER_Z, scrimTestId, type ModalMotion, type ModalTier } from '@renderer/modal-glass';

interface ModalFrameProps {
  /** Goes on the layer (which contains the panel); the scrim gets `${testId}-scrim`. */
  readonly testId: string;
  readonly tier: ModalTier;
  /** `fade` opts a mouse-opened modal into the backdrop fade; keyboard surfaces use `none`. */
  readonly motion: ModalMotion;
  /** Layout only (flex, alignment, padding). Never a filter, opacity or transform. */
  readonly layerClassName?: string;
  /** Called on a click on the scrim. Omit for a modal that must not be dismissed this way. */
  readonly onDismiss?: () => void;
  readonly children: ReactNode;
}

/**
 * The shared modal frame: a full-window tinted, blurred scrim and, as its sibling, a
 * pointer-transparent layer that positions the panel.
 *
 * They are siblings on purpose. An element with `backdrop-filter` is a Backdrop Root, so a panel
 * nested inside the blurred scrim could only blur the scrim's flat tint and its own glass would
 * silently vanish. The layer therefore carries no filter, opacity or transform, and clicks that
 * miss the panel fall through it to the scrim.
 */
export function ModalFrame({ testId, tier, motion, layerClassName, onDismiss, children }: ModalFrameProps): React.JSX.Element {
  const [scrimZ, layerZ] = MODAL_TIER_Z[tier];
  const scrimClass = [MODAL_CLASSES.scrim, motion === 'fade' ? MODAL_CLASSES.fadeScrim : null, 'fixed inset-0']
    .filter(Boolean)
    .join(' ');
  const layerClass = [MODAL_CLASSES.layer, 'fixed inset-0', layerClassName].filter(Boolean).join(' ');
  return (
    <>
      <div className={scrimClass} style={{ zIndex: scrimZ }} data-testid={scrimTestId(testId)} onClick={onDismiss} />
      <div className={layerClass} style={{ zIndex: layerZ }} data-testid={testId}>
        {children}
      </div>
    </>
  );
}
