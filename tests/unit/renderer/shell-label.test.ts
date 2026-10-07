import { describe, expect, it } from 'vitest';
import { shellChipLabel } from '@renderer/shell-label';

const shells = [
  { shellIndex: 0, launchName: 'Claude' },
  { shellIndex: 1, launchName: 'Terminal' },
  { shellIndex: 3, launchName: 'Terminal' },
];

describe('shellChipLabel', () => {
  it('returns the bare launch name when it is unique', () => {
    expect(shellChipLabel(shells, 0)).toBe('Claude');
  });

  it('suffixes duplicate names by their order in the list, not their shell index', () => {
    expect(shellChipLabel(shells, 1)).toBe('Terminal 1');
    expect(shellChipLabel(shells, 3)).toBe('Terminal 2');
  });

  it('returns an empty string for an index not in the list', () => {
    expect(shellChipLabel(shells, 2)).toBe('');
  });
});
