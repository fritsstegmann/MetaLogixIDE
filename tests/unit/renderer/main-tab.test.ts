import { describe, it, expect } from 'vitest';
import { isMainTab, MAIN_TABS } from '@renderer/main-tab';

describe('isMainTab', () => {
  it.each(['shell', 'files', 'diff', 'env'])('accepts the persisted tab %j', (tab) => {
    expect(isMainTab(tab)).toBe(true);
  });

  it.each([['bogus'], [null], [1], [undefined], ['Env'], ['Diff'], [['env']]])('rejects %j', (value) => {
    expect(isMainTab(value)).toBe(false);
  });

  it('orders the tabs Shell, Files, Diff, Env', () => {
    expect(MAIN_TABS).toEqual(['shell', 'files', 'diff', 'env']);
  });
});
