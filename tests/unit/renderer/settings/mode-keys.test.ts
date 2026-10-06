import { describe, it, expect } from 'vitest';
import { modeAfterKey } from '@renderer/components/settings/mode-keys';

describe('modeAfterKey', () => {
  it.each([
    ['system', 'ArrowRight', 'light'],
    ['light', 'ArrowRight', 'dark'],
    ['dark', 'ArrowRight', 'system'],
    ['system', 'ArrowDown', 'light'],
    ['dark', 'ArrowDown', 'system'],
  ] as const)('%s + %s advances to %s, wrapping at the end', (mode, key, next) => {
    expect(modeAfterKey(mode, key)).toBe(next);
  });

  it.each([
    ['dark', 'ArrowLeft', 'light'],
    ['light', 'ArrowLeft', 'system'],
    ['system', 'ArrowLeft', 'dark'],
    ['light', 'ArrowUp', 'system'],
    ['system', 'ArrowUp', 'dark'],
  ] as const)('%s + %s retreats to %s, wrapping at the start', (mode, key, next) => {
    expect(modeAfterKey(mode, key)).toBe(next);
  });

  it.each(['Enter', ' ', 'Tab', 'Home', 'a', 'arrowright'])('%j is not a move', (key) => {
    expect(modeAfterKey('light', key)).toBeNull();
  });
});
