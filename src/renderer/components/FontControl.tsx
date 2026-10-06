/**
 * Font preference combobox: one field that searches installed families,
 * accepts an exact family name, and offers "System default" in place of a
 * separate Reset button. Installed fonts load the first time the list opens.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  FontFamilyPreference,
  FontSettingKey,
} from '@shared/font-settings';
import { parseFontFamilyPreference } from '@shared/font-settings';
import { FONT_COPY, FONT_TEST_IDS } from '@renderer/fonts/font-contract';
import type { LocalFontAccessResult } from '@renderer/fonts/local-font-access';
import { buildFontFamilyStack } from '@renderer/fonts/font-family';

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

/** Longest list rendered at once; typing narrows it further. */
const MAX_VISIBLE_FAMILIES = 200;

type Option =
  | { readonly kind: 'default' }
  | { readonly kind: 'family'; readonly family: string }
  | { readonly kind: 'custom'; readonly family: string };

function testIds(settingKey: FontSettingKey): {
  readonly input: string;
  readonly reset: string;
  readonly status: string;
} {
  return settingKey === 'ui_font_family'
    ? { input: FONT_TEST_IDS.uiInput, reset: FONT_TEST_IDS.uiReset, status: FONT_TEST_IDS.uiStatus }
    : { input: FONT_TEST_IDS.terminalInput, reset: FONT_TEST_IDS.terminalReset, status: FONT_TEST_IDS.terminalStatus };
}

function includesFamily(families: readonly string[], family: string): boolean {
  const folded = family.toLowerCase();
  return families.some((candidate) => candidate.toLowerCase() === folded);
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

/** Renders and commits one independent UI or terminal font preference. */
export function FontControl({
  settingKey,
  label,
  value,
  fallback,
  discovery,
  onSave,
  onLoadInstalledFonts,
}: Props): React.JSX.Element {
  const reactId = useId();
  const inputId = `${reactId}-input`;
  const listId = `${reactId}-list`;
  const statusId = `${reactId}-status`;
  const errorId = `${reactId}-error`;
  const ids = testIds(settingKey);
  const [query, setQuery] = useState(value ?? '');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const families = useMemo<readonly string[]>(
    () => (discovery.status === 'success' ? discovery.families : []),
    [discovery],
  );
  const failure = discoveryFailure(discovery);

  useEffect(() => {
    setQuery(value ?? '');
  }, [value]);

  const options = useMemo<Option[]>(() => {
    const needle = query.trim().toLowerCase();
    // While the field still shows the saved family, list everything.
    const filtering = needle.length > 0 && needle !== (value ?? '').toLowerCase();
    const matches = filtering ? families.filter((f) => f.toLowerCase().includes(needle)) : families;
    const list: Option[] = [{ kind: 'default' }];
    for (const family of matches.slice(0, MAX_VISIBLE_FAMILIES)) list.push({ kind: 'family', family });
    const typed = query.trim();
    if (filtering && !includesFamily(families, typed)) list.push({ kind: 'custom', family: typed });
    return list;
  }, [families, query, value]);

  const selectedIndex = options.findIndex((o) =>
    value === null ? o.kind === 'default' : o.kind !== 'default' && o.family.toLowerCase() === value.toLowerCase());

  function openList(): void {
    if (open) return;
    setOpen(true);
    setActiveIndex(Math.max(0, selectedIndex));
    if (discovery.status === 'idle' || failure !== null) void onLoadInstalledFonts();
  }

  function closeList(restore: boolean): void {
    setOpen(false);
    if (restore) setQuery(value ?? '');
  }

  async function save(next: FontFamilyPreference): Promise<void> {
    if (savingRef.current || next === value) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(next);
    } catch {
      setSaveError(FONT_COPY.saveFailed);
      setQuery(value ?? '');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  /** Validates and saves typed text; empty text means the system default. */
  async function commitTyped(text: string): Promise<void> {
    if (text.trim().length === 0) {
      setValidationError(null);
      setQuery('');
      await save(null);
      return;
    }
    const parsed = parseFontFamilyPreference(text);
    if (!parsed.ok || parsed.value === null) {
      setValidationError(parsed.ok ? FONT_COPY.emptyName : parsed.error);
      return;
    }
    setValidationError(null);
    setQuery(parsed.value);
    await save(parsed.value);
  }

  async function choose(option: Option): Promise<void> {
    setValidationError(null);
    closeList(false);
    if (option.kind === 'default') {
      setQuery('');
      await save(null);
    } else {
      await commitTyped(option.family);
    }
  }

  const activeOption = Math.min(activeIndex, options.length - 1);
  const optionId = (index: number): string => `${listId}-${index}`;
  const describedBy = [statusId, validationError || saveError ? errorId : null].filter(Boolean).join(' ');
  const status = saving ? FONT_COPY.saving : statusText(value, discovery);

  return (
    <div className="grid items-start gap-x-4 gap-y-1.5 sm:grid-cols-[7.5rem_minmax(0,1fr)]">
      <label htmlFor={inputId} className="pt-2 text-sm text-[--text]">{label}</label>
      <div className="relative min-w-0 space-y-1.5">
        <div className="relative">
          <input
            ref={inputRef}
            id={inputId}
            name={settingKey}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open ? optionId(activeOption) : undefined}
            aria-invalid={validationError !== null}
            aria-describedby={describedBy}
            value={query}
            placeholder={FONT_COPY.defaultValue}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="done"
            disabled={saving}
            onFocus={openList}
            onClick={openList}
            onChange={(event) => {
              setQuery(event.target.value);
              setValidationError(null);
              setSaveError(null);
              // Typing highlights the first match (or "Use …"), never System default.
              setActiveIndex(event.target.value.trim().length > 0 ? 1 : 0);
              if (!open) openList();
            }}
            onBlur={(event) => {
              const text = event.currentTarget.value;
              closeList(false);
              if (text.trim() !== (value ?? '')) void commitTyped(text);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (!open) { openList(); return; }
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setActiveIndex((i) => (i + step + options.length) % options.length);
              } else if (event.key === 'Enter') {
                event.preventDefault();
                const option = open ? options[activeOption] : undefined;
                if (option) {
                  void choose(option);
                } else {
                  closeList(false);
                  void commitTyped(event.currentTarget.value);
                }
              } else if (event.key === 'Escape' && open) {
                event.preventDefault();
                event.stopPropagation();
                closeList(true);
              }
            }}
            className="min-h-11 w-full rounded-lg bg-[--surface-field] py-2 pl-3 pr-9 text-[15px] text-[--text] placeholder:text-[--text-muted] transition-colors hover:bg-[--surface-active] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent]/70 disabled:cursor-not-allowed disabled:opacity-50"
            style={{ fontFamily: buildFontFamilyStack(value, fallback) }}
            data-testid={ids.input}
          />
          <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[--text-muted]">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
          </span>
        </div>

        {open && (
          <ul
            id={listId}
            role="listbox"
            aria-label={`${label} options`}
            className="popover absolute left-0 right-0 top-12 z-20 max-h-64 overflow-y-auto rounded-lg bg-[--panel-strong] p-1 shadow-xl ring-1 ring-black/10"
            onMouseDown={(event) => event.preventDefault()}
          >
            {options.map((option, index) => {
              const selected = index === selectedIndex;
              const active = index === activeOption;
              const family = option.kind === 'default' ? null : option.family;
              return (
                <li
                  key={option.kind === 'default' ? '__default' : `${option.kind}:${option.family}`}
                  id={optionId(index)}
                  role="option"
                  aria-selected={selected}
                  data-testid={option.kind === 'default' ? ids.reset : undefined}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => void choose(option)}
                  className={`flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm ${
                    active ? 'bg-[--surface-active]' : ''
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
            })}
            {discovery.status === 'loading' && (
              <li role="presentation" className="px-2.5 py-2 text-xs text-[--text-muted]">{FONT_COPY.loading}</li>
            )}
            {failure !== null && (
              <li role="presentation" className="flex items-center justify-between gap-2 px-2.5 py-2 text-xs text-[--text-muted]">
                <span role="status">{failure}</span>
                <button
                  type="button"
                  onClick={() => void onLoadInstalledFonts()}
                  className="pressable shrink-0 rounded-md px-2 py-1 text-[--accent-soft-text] hover:bg-[--surface-hover]"
                >
                  {FONT_COPY.retry}
                </button>
              </li>
            )}
          </ul>
        )}

        <div
          className="truncate px-1 text-[13px] text-[--text-muted]"
          style={{ fontFamily: buildFontFamilyStack(value, fallback) }}
          aria-label={`${label} preview`}
        >
          {settingKey === 'ui_font_family'
            ? 'The quick brown fox jumps over the lazy dog.'
            : <>Aa 0O 1l → ~/project <span aria-label="private-use glyph sample">󰆍</span></>}
        </div>
        <p id={statusId} aria-live="polite" className="px-1 text-xs text-[--text-muted] empty:hidden" data-testid={ids.status}>
          {status}
        </p>
        {(validationError || saveError) && (
          <p id={errorId} role="alert" className="px-1 text-xs text-[--danger]">
            {validationError ?? saveError}
          </p>
        )}
      </div>
    </div>
  );
}
