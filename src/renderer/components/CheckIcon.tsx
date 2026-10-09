import { ICON_STROKE, type IconSize } from './icon-size';

/** Decorative check mark; callers convey selection through ARIA state, not this icon. */
export function CheckIcon({ size }: { readonly size: IconSize }): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE.check}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}
