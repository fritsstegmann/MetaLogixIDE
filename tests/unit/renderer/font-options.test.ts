import { describe, expect, it } from 'vitest';
import {
  MAX_VISIBLE_FAMILIES,
  activeOptionIndex,
  buildFontOptions,
  fontPickerReducer,
  initialPickerState,
  moveHighlight,
  optionKey,
  pointerMoved,
  resolveBlur,
  resolveEnter,
  selectedOptionIndex,
  validateFontEntry,
  type FontOption,
  type FontPickerEvent,
  type FontPickerState,
} from '@renderer/fonts/font-options';

/** Contract tests for the font combobox option list, validation and highlight (AC41–AC44). */

const DEFAULT: FontOption = { kind: 'default' };
const family = (name: string): FontOption => ({ kind: 'family', family: name });
const custom = (name: string): FontOption => ({ kind: 'custom', family: name });

function run(value: string | null, events: readonly FontPickerEvent[]): FontPickerState {
  return events.reduce(fontPickerReducer, initialPickerState(value));
}

describe('validateFontEntry (AC41, AC42)', () => {
  it.each(['', '   ', ' \t '])('treats empty or whitespace %j as System default', (text) => {
    expect(validateFontEntry(text)).toEqual({ ok: true, value: null });
  });

  it('trims outer whitespace and keeps every other character exactly', () => {
    const name = `Font "quoted", semi; slash\\ braces{} Ω 日本`;
    expect(validateFontEntry(`  ${name}  `)).toEqual({ ok: true, value: name });
  });

  it.each(['bad\u0000family', 'line\nbreak', 'esc\u001Bname', 'unit\u001Fsep'])('rejects C0 control in %j', (text) => {
    expect(validateFontEntry(text).ok).toBe(false);
  });

  it('counts the 256 limit in code points, not UTF-16 units', () => {
    expect(validateFontEntry('😀'.repeat(256))).toEqual({ ok: true, value: '😀'.repeat(256) });
    const over = validateFontEntry('😀'.repeat(257));
    expect(over.ok).toBe(false);
    expect(over.ok ? '' : over.error).not.toBe('');
  });
});

describe('buildFontOptions (AC41)', () => {
  const families = ['Alpha Font', 'Comma, Family', 'Éclair Mono', 'zeta Mono'];

  it('lists System default first then every family while the field is empty', () => {
    expect(buildFontOptions({ families, query: '', value: null })).toEqual([DEFAULT, ...families.map(family)]);
  });

  it('lists everything while the field still shows the saved family, in any case', () => {
    expect(buildFontOptions({ families, query: ' ZETA mono ', value: 'zeta Mono' })).toEqual([DEFAULT, ...families.map(family)]);
  });

  it('filters case-insensitively on trimmed text and appends the custom option', () => {
    expect(buildFontOptions({ families, query: '  ÉCL  ', value: null })).toEqual([DEFAULT, family('Éclair Mono'), custom('ÉCL')]);
  });

  it('omits the custom option when the text names a family exactly, ignoring case', () => {
    expect(buildFontOptions({ families, query: 'alpha font', value: null })).toEqual([DEFAULT, family('Alpha Font')]);
  });

  it('offers only System default and the custom option when nothing matches', () => {
    expect(buildFontOptions({ families, query: 'No such family', value: 'Alpha Font' })).toEqual([DEFAULT, custom('No such family')]);
  });

  it('offers the custom option with no installed fonts at all', () => {
    expect(buildFontOptions({ families: [], query: 'Typed', value: null })).toEqual([DEFAULT, custom('Typed')]);
  });

  it(`caps the families at ${MAX_VISIBLE_FAMILIES}`, () => {
    const many = Array.from({ length: MAX_VISIBLE_FAMILIES + 5 }, (_, i) => `Font ${i}`);
    const options = buildFontOptions({ families: many, query: '', value: null });
    expect(options).toHaveLength(MAX_VISIBLE_FAMILIES + 1);
    expect(options[MAX_VISIBLE_FAMILIES]).toEqual(family(`Font ${MAX_VISIBLE_FAMILIES - 1}`));
  });
});

describe('selectedOptionIndex and optionKey', () => {
  const options = [DEFAULT, family('Alpha'), family('Beta'), custom('Gamma')];

  it('marks System default when no family is saved', () => {
    expect(selectedOptionIndex(options, null)).toBe(0);
  });

  it('marks the saved family case-insensitively, or nothing when it is not listed', () => {
    expect(selectedOptionIndex(options, 'beta')).toBe(2);
    expect(selectedOptionIndex(options, 'Missing')).toBe(-1);
  });

  it('gives each option a distinct identity', () => {
    expect(new Set([...options, custom('Alpha')].map(optionKey)).size).toBe(5);
  });
});

describe('highlight after typing (AC43)', () => {
  const families = ['Alpha Font', 'Beta Mono', 'Éclair Mono', 'Zeta Mono'];

  it('B2 trigger 1: typing into a closed list opens it on the custom option and Enter saves the typed text', () => {
    const state = run('Old Family', [{ type: 'type', text: '  Trimmed Ω Family  ' }]);
    const options = buildFontOptions({ families: [], query: state.query, value: 'Old Family' });
    expect(state.open).toBe(true);
    expect(activeOptionIndex(options, state, 'Old Family')).toBe(1);
    expect(resolveEnter(state, options, 'Old Family')).toEqual({ kind: 'choose', option: custom('Trimmed Ω Family') });
  });

  it('B2 trigger 1 with fonts listed: Enter saves the first match, not the saved family’s stale position', () => {
    const state = run('Zeta Mono', [{ type: 'type', text: 'écl' }]);
    const options = buildFontOptions({ families, query: state.query, value: 'Zeta Mono' });
    expect(activeOptionIndex(options, state, 'Zeta Mono')).toBe(1);
    expect(resolveEnter(state, options, 'Zeta Mono')).toEqual({ kind: 'choose', option: family('Éclair Mono') });
  });

  it('typing into an open list re-targets the best match and drops an earlier arrow highlight', () => {
    const state = run(null, [{ type: 'open' }, { type: 'highlight', key: optionKey(family('Zeta Mono')) }, { type: 'type', text: 'mono' }]);
    const options = buildFontOptions({ families, query: state.query, value: null });
    expect(options).toContainEqual(family('Zeta Mono'));
    expect(resolveEnter(state, options, null)).toEqual({ kind: 'choose', option: family('Beta Mono') });
  });

  it('clearing the field highlights System default and Enter saves it', () => {
    const state = run('Beta Mono', [{ type: 'type', text: '   ' }]);
    const options = buildFontOptions({ families, query: state.query, value: 'Beta Mono' });
    expect(activeOptionIndex(options, state, 'Beta Mono')).toBe(0);
    expect(resolveEnter(state, options, 'Beta Mono')).toEqual({ kind: 'choose', option: DEFAULT });
  });

  it('retyping the saved family saves nothing even when it is not listed', () => {
    const state = run('Beta Mono', [{ type: 'type', text: 'Beta' }, { type: 'type', text: 'beta mono' }]);
    const options = buildFontOptions({ families: [], query: state.query, value: 'Beta Mono' });
    expect(resolveEnter(state, options, 'Beta Mono')).toEqual({ kind: 'none' });
  });
});

describe('highlight when options change (AC44)', () => {
  it('B2 trigger 2: discovery finishing after first focus leaves Enter a no-op on the unmodified field', () => {
    const state = run('Beta Mono', [{ type: 'open' }]);
    const before = buildFontOptions({ families: [], query: state.query, value: 'Beta Mono' });
    expect(before).toEqual([DEFAULT]);
    const after = buildFontOptions({ families: ['Alpha Font', 'Beta Mono'], query: state.query, value: 'Beta Mono' });
    expect(activeOptionIndex(after, state, 'Beta Mono')).toBe(2);
    expect(resolveEnter(state, after, 'Beta Mono')).toEqual({ kind: 'none' });
  });

  it('opening an unmodified field highlights the saved family', () => {
    const state = run('Beta Mono', [{ type: 'open' }]);
    const options = buildFontOptions({ families: ['Alpha Font', 'Beta Mono'], query: state.query, value: 'Beta Mono' });
    expect(activeOptionIndex(options, state, 'Beta Mono')).toBe(2);
  });

  it('keeps an arrow highlight on the same option when the list grows above it', () => {
    const state = run(null, [{ type: 'open' }, { type: 'highlight', key: optionKey(family('Beta')) }]);
    const grown = [DEFAULT, family('Alpha'), family('Aleph'), family('Beta')];
    expect(activeOptionIndex(grown, state, null)).toBe(3);
    expect(resolveEnter(state, grown, null)).toEqual({ kind: 'choose', option: family('Beta') });
  });

  it('falls back to the best match when the highlighted option disappears', () => {
    const state = run(null, [{ type: 'type', text: 'Xe' }, { type: 'highlight', key: optionKey(custom('Xe')) }]);
    const after = buildFontOptions({ families: ['Xenon'], query: 'Xe', value: null });
    expect(after).toEqual([DEFAULT, family('Xenon'), custom('Xe')]);
    expect(activeOptionIndex([DEFAULT, family('Xenon')], state, null)).toBe(1);
  });

  it('moves a typed highlight from the custom option to a family discovery adds', () => {
    const state = run(null, [{ type: 'type', text: 'Xe' }]);
    const before = buildFontOptions({ families: [], query: 'Xe', value: null });
    expect(before[activeOptionIndex(before, state, null)]).toEqual(custom('Xe'));
    const after = buildFontOptions({ families: ['Xenon'], query: 'Xe', value: null });
    expect(after[activeOptionIndex(after, state, null)]).toEqual(family('Xenon'));
  });
});

describe('fontPickerReducer and keyboard', () => {
  const options = [DEFAULT, family('Alpha'), family('Beta')];

  it('starts closed and unmodified, showing the saved family', () => {
    expect(initialPickerState('Alpha')).toEqual({ query: 'Alpha', open: false, activeKey: null, dirty: false, typed: false, activeByPointer: false });
    expect(initialPickerState(null).query).toBe('');
  });

  it('returns the same state when opening an open list', () => {
    const open = run(null, [{ type: 'open' }]);
    expect(fontPickerReducer(open, { type: 'open' })).toBe(open);
  });

  it('close keeps the typed text; reset restores it and clears the edit', () => {
    const typed = run('Alpha', [{ type: 'type', text: 'Be' }, { type: 'highlight', key: 'x' }]);
    const closed = fontPickerReducer(typed, { type: 'close' });
    expect(closed).toMatchObject({ open: false, query: 'Be', activeKey: null });
    expect(fontPickerReducer(closed, { type: 'reset', query: 'Alpha' })).toEqual(initialPickerState('Alpha'));
  });

  it('an arrow highlight on an unmodified field makes Enter save that option', () => {
    const state = run('Alpha', [{ type: 'open' }, { type: 'highlight', key: moveHighlight(options, 1, 1) }]);
    expect(state.dirty).toBe(true);
    expect(resolveEnter(state, options, 'Alpha')).toEqual({ kind: 'choose', option: family('Beta') });
  });

  it('moveHighlight steps both ways and wraps', () => {
    expect(moveHighlight(options, 0, 1)).toBe(optionKey(family('Alpha')));
    expect(moveHighlight(options, 2, 1)).toBe(optionKey(DEFAULT));
    expect(moveHighlight(options, 0, -1)).toBe(optionKey(family('Beta')));
  });

  it('Enter on a closed unmodified field saves nothing', () => {
    expect(resolveEnter(initialPickerState('Alpha'), options, 'Alpha')).toEqual({ kind: 'none' });
  });

  it('Enter on a closed edited field commits the typed text', () => {
    const closed = run('Alpha', [{ type: 'type', text: 'Gamma' }, { type: 'close' }]);
    expect(resolveEnter(closed, options, 'Alpha')).toEqual({ kind: 'commit', text: 'Gamma' });
  });
});

describe('pointerMoved (F1: a still pointer must not steal the highlight)', () => {
  it('is false when the pointer has not moved since the last event', () => {
    expect(pointerMoved({ x: 10, y: 20 }, { x: 10, y: 20 })).toBe(false);
  });

  it('is true when either coordinate changed', () => {
    expect(pointerMoved({ x: 10, y: 20 }, { x: 11, y: 20 })).toBe(true);
    expect(pointerMoved({ x: 10, y: 20 }, { x: 10, y: 19 })).toBe(true);
  });

  it('is false for the first event, so a list opening under the pointer keeps the typed highlight', () => {
    expect(pointerMoved(null, { x: 10, y: 20 })).toBe(false);
  });
});

describe('best match prefers exact, then prefix (gate C1)', () => {
  const families = ['Apple Symbols', 'Symbol', 'Symbola', 'Noto Sans Symbols'];
  const typed = (text: string) => {
    const state = run(null, [{ type: 'type', text }]);
    const options = buildFontOptions({ families, query: text, value: null });
    return { state, options, index: activeOptionIndex(options, state, null) };
  };

  it('highlights and saves the exact family name over earlier substring matches', () => {
    const { state, options, index } = typed('Symbol');
    expect(options[index]).toEqual(family('Symbol'));
    expect(resolveEnter(state, options, null)).toEqual({ kind: 'choose', option: family('Symbol') });
  });

  it('matches the exact name ignoring case', () => {
    const { options, index } = typed('symbol');
    expect(options[index]).toEqual(family('Symbol'));
  });

  it('prefers a family that starts with the text over one that only contains it', () => {
    const { options, index } = typed('Symbo');
    expect(options[index]).toEqual(family('Symbol'));
  });

  it('falls back to the first containing family when nothing starts with the text', () => {
    const { options, index } = typed('ymbols');
    expect(options[index]).toEqual(family('Apple Symbols'));
  });
});

describe('resolveBlur matches Enter (gate C2)', () => {
  const families = ['Alpha Sans', 'Beta Mono'];

  it('saves the highlighted best match, not the raw typed text', () => {
    const state = run('Beta Mono', [{ type: 'type', text: 'sans' }]);
    const options = buildFontOptions({ families, query: 'sans', value: 'Beta Mono' });
    expect(resolveBlur(state, options, 'Beta Mono')).toEqual({ kind: 'choose', option: family('Alpha Sans') });
    expect(resolveBlur(state, options, 'Beta Mono')).toEqual(resolveEnter(state, options, 'Beta Mono'));
  });

  it('saves nothing for an unedited field', () => {
    const state = run('Beta Mono', [{ type: 'open' }]);
    const options = buildFontOptions({ families, query: 'Beta Mono', value: 'Beta Mono' });
    expect(resolveBlur(state, options, 'Beta Mono')).toEqual({ kind: 'none' });
  });

  it('saves an explicitly highlighted option', () => {
    const state = run(null, [{ type: 'open' }, { type: 'highlight', key: optionKey(family('Beta Mono')) }]);
    const options = buildFontOptions({ families, query: '', value: null });
    expect(resolveBlur(state, options, null)).toEqual({ kind: 'choose', option: family('Beta Mono') });
  });

  it('saves the custom option when typed text matches no family', () => {
    const state = run(null, [{ type: 'type', text: 'Zed Mono' }]);
    const options = buildFontOptions({ families, query: 'Zed Mono', value: null });
    expect(resolveBlur(state, options, null)).toEqual({ kind: 'choose', option: custom('Zed Mono') });
  });
});

describe('exact name beats an earlier prefix match (gate M3)', () => {
  it('saves the exact family even when another family starts with the same text first', () => {
    const families = ['Symbol Neu', 'Symbol'];
    const state = run(null, [{ type: 'type', text: 'symbol' }]);
    const options = buildFontOptions({ families, query: 'symbol', value: null });
    expect(options[activeOptionIndex(options, state, null)]).toEqual(family('Symbol'));
  });
});

describe('blur ignores a highlight set only by the pointer (gate M1)', () => {
  const families = ['Alpha Sans', 'Beta Mono'];
  const hover = (name: string): FontPickerEvent => ({ type: 'highlight', key: optionKey(family(name)), via: 'pointer' });

  it('saves nothing when the pointer merely passed over a row of an unedited field', () => {
    const state = run('Beta Mono', [{ type: 'open' }, hover('Alpha Sans')]);
    const options = buildFontOptions({ families, query: 'Beta Mono', value: 'Beta Mono' });
    expect(resolveBlur(state, options, 'Beta Mono')).toEqual({ kind: 'none' });
  });

  it('saves the typed best match, not a hovered row that is still listed', () => {
    const both = ['Alpha Sans', 'Alpha Mono'];
    const state = run(null, [{ type: 'type', text: 'alpha' }, hover('Alpha Mono')]);
    const options = buildFontOptions({ families: both, query: 'alpha', value: null });
    expect(options).toContainEqual(family('Alpha Mono'));
    expect(resolveBlur(state, options, null)).toEqual({ kind: 'choose', option: family('Alpha Sans') });
  });

  it('still saves a row chosen with the arrow keys', () => {
    const state = run(null, [{ type: 'open' }, { type: 'highlight', key: optionKey(family('Beta Mono')) }]);
    const options = buildFontOptions({ families, query: '', value: null });
    expect(resolveBlur(state, options, null)).toEqual({ kind: 'choose', option: family('Beta Mono') });
  });

  it('keeps Enter saving the hovered row (approved hover rule)', () => {
    const state = run(null, [{ type: 'open' }, hover('Beta Mono')]);
    const options = buildFontOptions({ families, query: '', value: null });
    expect(resolveEnter(state, options, null)).toEqual({ kind: 'choose', option: family('Beta Mono') });
  });

  it('saves nothing when a hover replaced an arrow highlight and nothing was typed', () => {
    const state = run('Beta Mono', [{ type: 'open' }, { type: 'highlight', key: optionKey(family('Alpha Sans')) }, hover('Beta Mono')]);
    const options = buildFontOptions({ families, query: 'Beta Mono', value: 'Beta Mono' });
    expect(resolveBlur(state, options, 'Beta Mono')).toEqual({ kind: 'none' });
  });
});
