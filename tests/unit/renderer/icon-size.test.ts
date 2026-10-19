import { describe, expect, it } from 'vitest';
import { ICON_SIZE, ICON_STROKE, iconStroke } from '@renderer/components/icon-size';

describe('icon size scale', () => {
  it('is exactly 10 / 12 / 14 / 16 / 20, with md (14) as the default', () => {
    expect(ICON_SIZE).toEqual({ xs: 10, sm: 12, md: 14, lg: 16, xl: 20 });
  });

  it('has outline 2, xs 2.5 and check 3 strokes', () => {
    expect(ICON_STROKE).toEqual({ outline: 2, xs: 2.5, check: 3 });
  });

  it('gives 2.5 at xs and 2 at every other size', () => {
    expect(iconStroke(ICON_SIZE.xs)).toBe(2.5);
    for (const size of [ICON_SIZE.sm, ICON_SIZE.md, ICON_SIZE.lg, ICON_SIZE.xl]) {
      expect(iconStroke(size)).toBe(2);
    }
  });
});
