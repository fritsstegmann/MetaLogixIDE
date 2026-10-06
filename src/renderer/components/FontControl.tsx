/**
 * Font preference combobox: one field that searches installed families,
 * accepts an exact family name, and offers "System default" in place of a
 * separate Reset button. Installed fonts load the first time the list opens.
 * Option and highlight rules live in `@renderer/fonts/font-options`.
 */

import { useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import type { Dispatch } from 'react';
import type {
  FontFamilyPreference,
  FontSettingKey,
} from '@shared/font-settings';
import { FONT_COPY, FONT_TEST_IDS } from '@renderer/fonts/font-contract';
import type { LocalFontAccessResult } from '@renderer/fonts/local-font-access';
import { buildFontFamilyStack } from '@renderer/fonts/font-family';
import {
  activeOptionIndex,
  buildFontOptions,
  fontPickerReducer,
  includesFamily,
  initialPickerState,
  moveHighlight,
  optionKey,
  resolveEnter,
  selectedOptionIndex,
  validateFontEntry,
  type FontOption,
  type FontPickerEvent,
  type FontPickerState,
} from '@renderer/fonts/font-options';

export type FontDiscoveryState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | LocalFontAccessResult;

interface Props {
  readonly settingKey: FontSettingKey;
  readonly label: string;
  readonly value: FontFamilyPreference;
  readonly fallback: string;
  readonly discovery: FontDiscoveryState;
  readonly onSave: (value: FontFamilyPreference) => Promise<void>;
  readonly onLoadInstalledFonts: () => Promise<void>;
}

interface FieldIds {
  readonly input: string;
  readonly list: string;
  readonly status: string;
  readonly error: string;
  readonly testInput: string;
  readonly testReset: string;
  readonly testStatus: string;
}

interface FontCommit {
  readonly saving: boolean;
  readonly error: string | null;
  readonly invalid: boolean;
  readonly commitTyped: (text: string) => Promise<void>;
  readonly choose: (option: FontOption) => Promise<void>;
  readonly clearErrors: () => void;
}

interface FontPicker {
  readonly state: FontPickerState;
  readonly options: readonly FontOption[];
  readonly activeIndex: number;
  readonly selectedIndex: number;
  readonly commit: FontCommit;
  readonly open: () => void;
  readonly type: (text: string) => void;
  readonly highlight: (index: number) => void;
  readonly step: (step: 1 | -1) => void;
  readonly enter: () => void;
  readonly escape: () => void;
  readonly blur: (text: string) => void;
}

type KeyHandler = (event: React.KeyboardEvent<HTMLInputElement>) => void;

function useFieldIds(settingKey: FontSettingKey): FieldIds {
  const reactId = useId();
  const ui = settingKey === 'ui_font_family';
  return {
    input: `${reactId}-input`,
    list: `${reactId}-list`,
    status: `${reactId}-status`,
    error: `${reactId}-error`,
    testInput: ui ? FONT_TEST_IDS.uiInput : FONT_TEST_IDS.terminalInput,
    testReset: ui ? FONT_TEST_IDS.uiReset : FONT_TEST_IDS.terminalReset,
    testStatus: ui ? FONT_TEST_IDS.uiStatus : FONT_TEST_IDS.terminalStatus,
  };
}

function optionId(ids: FieldIds, index: number): string {
  return `${ids.list}-${index}`;
}

function discoveryFailure(discovery: FontDiscoveryState): string | null {
  if (discovery.status === 'unsupported') return FONT_COPY.discoveryUnsupported;
  if (discovery.status === 'denied') return FONT_COPY.discoveryDenied;
  if (discovery.status === 'error') return FONT_COPY.discoveryError;
  return null;
}

/** Status shown under the field — empty unless something needs attention. */
function statusText(value: FontFamilyPreference, discovery: FontDiscoveryState): string {
  if (value === null) return '';
  if (discovery.status === 'success') {
    return includesFamily(discovery.families, value) ? '' : FONT_COPY.unavailable;
  }
  return discoveryFailure(discovery) === null ? '' : FONT_COPY.unknown;
}

/** Serialises saves; resolves false when `onSave` rejects so the caller can restore the field. */
function useFontSave(value: FontFamilyPreference, onSave: Props['onSave']) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savingRef = useRef(false);
  async function save(next: FontFamilyPreference): Promise<boolean> {
    if (savingRef.current || next === value) return true;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(next);
      return true;
    } catch {
      setSaveError(FONT_COPY.saveFailed);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  return { saving, saveError, setSaveError, save };
}

/** Validates and saves typed text or a chosen option; empty text means the system default. */
function useFontCommit(value: FontFamilyPreference, onSave: Props['onSave'], dispatch: Dispatch<FontPickerEvent>): FontCommit {
  const [validationError, setValidationError] = useState<string | null>(null);
  const { saving, saveError, setSaveError, save } = useFontSave(value, onSave);
  async function commitTyped(text: string): Promise<void> {
    const entry = validateFontEntry(text);
    if (!entry.ok) {
      setValidationError(entry.error);
      return;
    }
    setValidationError(null);
    dispatch({ type: 'reset', query: entry.value ?? '' });
    if (!(await save(entry.value))) dispatch({ type: 'reset', query: value ?? '' });
  }
  return {
    saving,
    error: validationError ?? saveError,
    invalid: validationError !== null,
    commitTyped,
    choose: async (option) => {
      dispatch({ type: 'close' });
      await commitTyped(option.kind === 'default' ? '' : option.family);
    },
    clearErrors: () => {
      setValidationError(null);
      setSaveError(null);
    },
  };
}

/** Wires the pure picker reducer to discovery, saving and the field's events. */
function useFontPicker({ value, discovery, onSave, onLoadInstalledFonts }: Props): FontPicker {
  const [state, dispatch] = useReducer(fontPickerReducer, value, initialPickerState);
  const commit = useFontCommit(value, onSave, dispatch);
  const families = useMemo(() => (discovery.status === 'success' ? discovery.families : []), [discovery]);
  const options = useMemo(() => buildFontOptions({ families, query: state.query, value }), [families, state.query, value]);
  const activeIndex = activeOptionIndex(options, state, value);
  useEffect(() => dispatch({ type: 'reset', query: value ?? '' }), [value]);
  const loadIfClosed = (): void => {
    if (!state.open && (discovery.status === 'idle' || discoveryFailure(discovery) !== null)) void onLoadInstalledFonts();
  };
  const restore = (): void => dispatch({ type: 'reset', query: value ?? '' });
  return {
    state, options, activeIndex, commit,
    selectedIndex: selectedOptionIndex(options, value),
    open: () => { loadIfClosed(); dispatch({ type: 'open' }); },
    type: (text) => { loadIfClosed(); commit.clearErrors(); dispatch({ type: 'type', text }); },
    highlight: (index) => { const option = options[index]; if (option) dispatch({ type: 'highlight', key: optionKey(option) }); },
    step: (step) => dispatch({ type: 'highlight', key: moveHighlight(options, activeIndex, step) }),
    enter: () => {
      const action = resolveEnter(state, options, value);
      dispatch({ type: 'close' });
      if (action.kind === 'choose') void commit.choose(action.option);
      else if (action.kind === 'commit') void commit.commitTyped(action.text);
      else restore();
    },
    escape: () => { dispatch({ type: 'close' }); restore(); },
    blur: (text) => { dispatch({ type: 'close' }); if (text.trim() !== (value ?? '')) void commit.commitTyped(text); },
  };
}

function keyHandlers(picker: FontPicker): Partial<Record<string, KeyHandler>> {
  const arrow = (step: 1 | -1): KeyHandler => (event) => {
    event.preventDefault();
    if (picker.state.open) picker.step(step);
    else picker.open();
  };
  return {
    ArrowDown: arrow(1),
    ArrowUp: arrow(-1),
    Enter: (event) => {
      event.preventDefault();
      picker.enter();
    },
    Escape: (event) => {
      if (!picker.state.open) return;
      event.preventDefault();
      event.stopPropagation();
      picker.escape();
    },
  };
}

function FontInput({ picker, ids, settingKey, value, fallback }: {
  readonly picker: FontPicker;
  readonly ids: FieldIds;
  readonly settingKey: FontSettingKey;
  readonly value: FontFamilyPreference;
  readonly fallback: string;
}): React.JSX.Element {
  const { state, commit } = picker;
  const handlers = keyHandlers(picker);
  return (
    <div className="relative">
      <input
        id={ids.input}
        name={settingKey}
        type="text"
        role="combobox"
        aria-expanded={state.open}
        aria-controls={ids.list}
        aria-autocomplete="list"
        aria-activedescendant={state.open ? optionId(ids, picker.activeIndex) : undefined}
        aria-invalid={commit.invalid}
        aria-describedby={[ids.status, commit.error ? ids.error : null].filter(Boolean).join(' ')}
        value={state.query}
        placeholder={FONT_COPY.defaultValue}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="done"
        disabled={commit.saving}
        onFocus={picker.open}
        onClick={picker.open}
        onChange={(event) => picker.type(event.target.value)}
        onBlur={(event) => picker.blur(event.currentTarget.value)}
        onKeyDown={(event) => handlers[event.key]?.(event)}
        className="min-h-11 w-full rounded-lg bg-[--surface-field] py-2 pl-3 pr-9 text-[15px] text-[--text] placeholder:text-[--text-muted] transition-colors hover:bg-[--surface-active] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent]/70 disabled:cursor-not-allowed disabled:opacity-50"
        style={{ fontFamily: buildFontFamilyStack(value, fallback) }}
        data-testid={ids.testInput}
      />
      <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[--text-muted]">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </span>
    </div>
  );
}

function FontOptionRow({ picker, ids, index, option, fallback }: {
  readonly picker: FontPicker;
  readonly ids: FieldIds;
  readonly index: number;
  readonly option: FontOption;
  readonly fallback: string;
}): React.JSX.Element {
  const selected = index === picker.selectedIndex;
  const family = option.kind === 'default' ? null : option.family;
  return (
    <li
      id={optionId(ids, index)}
      role="option"
      aria-selected={selected}
      data-testid={option.kind === 'default' ? ids.testReset : undefined}
      onMouseEnter={() => picker.highlight(index)}
      onClick={() => void picker.commit.choose(option)}
      className={`flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm ${
        index === picker.activeIndex ? 'bg-[--surface-active]' : ''
      }`}
    >
      <span aria-hidden className={`w-4 shrink-0 text-[--accent] ${selected ? '' : 'invisible'}`}>✓</span>
      {option.kind === 'custom' ? (
        <span className="truncate">{FONT_COPY.customOption(option.family)}</span>
      ) : (
        <span className="truncate" style={{ fontFamily: buildFontFamilyStack(family, fallback) }}>
          {family ?? FONT_COPY.defaultValue}
        </span>
      )}
    </li>
  );
}

function DiscoveryNotice({ discovery, onRetry }: {
  readonly discovery: FontDiscoveryState;
  readonly onRetry: () => Promise<void>;
}): React.JSX.Element | null {
  const failure = discoveryFailure(discovery);
  if (discovery.status === 'loading') {
    return <li role="presentation" className="px-2.5 py-2 text-xs text-[--text-muted]">{FONT_COPY.loading}</li>;
  }
  if (failure === null) return null;
  return (
    <li role="presentation" className="flex items-center justify-between gap-2 px-2.5 py-2 text-xs text-[--text-muted]">
      <span role="status">{failure}</span>
      <button
        type="button"
        onClick={() => void onRetry()}
        className="pressable shrink-0 rounded-md px-2 py-1 text-[--accent-soft-text] hover:bg-[--surface-hover]"
      >
        {FONT_COPY.retry}
      </button>
    </li>
  );
}

function FontOptionList({ picker, ids, label, fallback, discovery, onRetry }: {
  readonly picker: FontPicker;
  readonly ids: FieldIds;
  readonly label: string;
  readonly fallback: string;
  readonly discovery: FontDiscoveryState;
  readonly onRetry: () => Promise<void>;
}): React.JSX.Element {
  return (
    <ul
      id={ids.list}
      role="listbox"
      aria-label={`${label} options`}
      className="popover absolute left-0 right-0 top-12 z-20 max-h-64 overflow-y-auto rounded-lg bg-[--panel-strong] p-1 shadow-xl ring-1 ring-black/10"
      onMouseDown={(event) => event.preventDefault()}
    >
      {picker.options.map((option, index) => (
        <FontOptionRow key={optionKey(option)} picker={picker} ids={ids} index={index} option={option} fallback={fallback} />
      ))}
      <DiscoveryNotice discovery={discovery} onRetry={onRetry} />
    </ul>
  );
}

function FontPreview({ settingKey, label, value, fallback }: {
  readonly settingKey: FontSettingKey;
  readonly label: string;
  readonly value: FontFamilyPreference;
  readonly fallback: string;
}): React.JSX.Element {
  return (
    <div
      className="truncate px-1 text-[13px] text-[--text-muted]"
      style={{ fontFamily: buildFontFamilyStack(value, fallback) }}
      aria-label={`${label} preview`}
    >
      {settingKey === 'ui_font_family'
        ? 'The quick brown fox jumps over the lazy dog.'
        : <>Aa 0O 1l → ~/project <span aria-label="private-use glyph sample">󰆍</span></>}
    </div>
  );
}

/** Renders and commits one independent UI or terminal font preference. */
export function FontControl(props: Props): React.JSX.Element {
  const { settingKey, label, value, fallback, discovery, onLoadInstalledFonts } = props;
  const ids = useFieldIds(settingKey);
  const picker = useFontPicker(props);
  const { commit } = picker;
  return (
    <div className="grid items-start gap-x-4 gap-y-1.5 sm:grid-cols-[7.5rem_minmax(0,1fr)]">
      <label htmlFor={ids.input} className="pt-2 text-sm text-[--text]">{label}</label>
      <div className="relative min-w-0 space-y-1.5">
        <FontInput picker={picker} ids={ids} settingKey={settingKey} value={value} fallback={fallback} />
        {picker.state.open && (
          <FontOptionList picker={picker} ids={ids} label={label} fallback={fallback} discovery={discovery} onRetry={onLoadInstalledFonts} />
        )}
        <FontPreview settingKey={settingKey} label={label} value={value} fallback={fallback} />
        <p id={ids.status} aria-live="polite" className="px-1 text-xs text-[--text-muted] empty:hidden" data-testid={ids.testStatus}>
          {commit.saving ? FONT_COPY.saving : statusText(value, discovery)}
        </p>
        {commit.error && (
          <p id={ids.error} role="alert" className="px-1 text-xs text-[--danger]">{commit.error}</p>
        )}
      </div>
    </div>
  );
}
