export interface SegmentedRadioGroupProps<T extends string> {
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  disabled?: boolean;
  testId?: string;
  onChange: (value: T) => void;
}

/** Keyboard-operable radiogroup with roving focus and arrow keys, like the Mode control. */
export function SegmentedRadioGroup<T extends string>(props: SegmentedRadioGroupProps<T>) {
  void props;
  throw new Error('not implemented');
}
