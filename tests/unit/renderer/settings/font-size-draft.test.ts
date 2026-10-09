import { describe, it, expect } from 'vitest';
import { initialDraft, onCommit, onExternalUpdate, onInput } from '@renderer/components/settings/font-size-draft';

describe('onInput', () => {
  it.each([
    ['16', 16],
    ['1', null],
    ['40', null],
    ['', null],
  ])('typing %s commits %s', (raw, commit) => {
    const result = onInput(raw);
    expect(result.commit).toBe(commit);
    expect(result.state.draft).toBe(raw);
    expect(result.state.editing).toBe(true);
  });
});

describe('onCommit', () => {
  it.each([
    ['40', 14, 28],
    ['0', 14, 9],
    ['-3', 14, 9],
  ])('blur/Enter on out-of-range %s (saved %d) clamps and commits %d', (raw, saved, commit) => {
    const result = onCommit(raw, saved);
    expect(result.commit).toBe(commit);
    expect(result.state.draft).toBe(String(commit));
    expect(result.state.editing).toBe(false);
  });

  it.each(['', 'abc', '16.5'])('blur/Enter on invalid draft %s reverts with no save', (raw) => {
    const result = onCommit(raw, 20);
    expect(result.commit).toBeNull();
    expect(result.state.draft).toBe('20');
    expect(result.state.editing).toBe(false);
  });

  it('blur/Enter on the already-saved value does not save', () => {
    const result = onCommit('16', 16);
    expect(result.commit).toBeNull();
    expect(result.state.draft).toBe('16');
    expect(result.state.editing).toBe(false);
  });
});

describe('onExternalUpdate', () => {
  it('replaces the draft when the field is not being edited', () => {
    const state = { draft: '14', editing: false };
    expect(onExternalUpdate(state, 18)).toEqual({ draft: '18', editing: false });
  });

  it('keeps the uncommitted draft when the field is being edited', () => {
    const state = { draft: '1', editing: true };
    expect(onExternalUpdate(state, 18)).toEqual(state);
  });
});

describe('initialDraft', () => {
  it('starts from the saved value, not editing', () => {
    expect(initialDraft(14)).toEqual({ draft: '14', editing: false });
  });
});
