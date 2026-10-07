import { describe, it, expect } from 'vitest';
import {
  SPLIT_RATIO_DEFAULT,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  clampRatio,
  ratioAriaValue,
  sanitizeRatio,
  stepRatio,
} from '@renderer/split-ratio';

describe('split ratio constants', () => {
  it('defaults to an even split inside a 15–85% clamp', () => {
    expect(SPLIT_RATIO_DEFAULT).toBe(0.5);
    expect(SPLIT_RATIO_MIN).toBe(0.15);
    expect(SPLIT_RATIO_MAX).toBe(0.85);
  });
});

describe('sanitizeRatio', () => {
  it.each([['0.7'], [NaN], [Infinity], [-Infinity], [null], [undefined], [{}]])(
    'falls back to the default for %p',
    (value) => {
      expect(sanitizeRatio(value)).toBe(0.5);
    },
  );

  it('clamps out-of-range numbers', () => {
    expect(sanitizeRatio(0.05)).toBe(0.15);
    expect(sanitizeRatio(0.95)).toBe(0.85);
  });

  it('passes an in-range ratio through', () => {
    expect(sanitizeRatio(0.3)).toBe(0.3);
  });
});

describe('clampRatio', () => {
  it('holds the bounds and passes interior values', () => {
    expect(clampRatio(0.15)).toBe(0.15);
    expect(clampRatio(0.85)).toBe(0.85);
    expect(clampRatio(0.1)).toBe(0.15);
    expect(clampRatio(0.9)).toBe(0.85);
    expect(clampRatio(0.42)).toBe(0.42);
  });
});

describe('stepRatio', () => {
  it('moves by 0.02 per step', () => {
    expect(stepRatio(0.5, -1)).toBe(0.48);
    expect(stepRatio(0.5, 1)).toBe(0.52);
  });

  it('clamps at both ends', () => {
    expect(stepRatio(0.16, -1)).toBe(0.15);
    expect(stepRatio(0.84, 1)).toBe(0.85);
    expect(stepRatio(0.15, -1)).toBe(0.15);
  });

  it('does not drift over repeated presses', () => {
    let r = 0.5;
    for (let i = 0; i < 20; i++) r = stepRatio(r, 1);
    expect(r).toBe(0.85);
    r = 0.5;
    for (let i = 0; i < 7; i++) r = stepRatio(r, -1);
    expect(r).toBe(0.36);
  });

  it('snaps an off-grid drag ratio onto two decimals', () => {
    expect(stepRatio(0.5037, 1)).toBe(0.52);
  });
});

describe('ratioAriaValue', () => {
  it('is the rounded percentage', () => {
    expect(ratioAriaValue(0.5)).toBe(50);
    expect(ratioAriaValue(0.505)).toBe(51);
    expect(ratioAriaValue(0.333)).toBe(33);
  });
});
