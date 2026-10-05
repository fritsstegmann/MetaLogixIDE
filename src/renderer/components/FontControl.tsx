/**
 * Accessible font preference control with manual entry, installed-family search, preview, and reset.
 */

import { useEffect, useId, useRef, useState } from 'react';
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
}

const AVAILABLE_COPY = 'Font is installed on this computer.';
const DEFAULT_COPY = 'Using the default font stack.';

function testIds(settingKey: FontSettingKey): {
  readonly input: string;
  readonly reset: string;
  readonly status: string;
} {
  return settingKey === 'ui_font_family'
    ? {
        input: FONT_TEST_IDS.uiInput,
        reset: FONT_TEST_IDS.uiReset,
        status: FONT_TEST_IDS.uiStatus,
      }
    : {
        input: FONT_TEST_IDS.terminalInput,
        reset: FONT_TEST_IDS.terminalReset,
        status: FONT_TEST_IDS.terminalStatus,
      };
}

function includesFamily(families: readonly string[], family: string): boolean {
  const folded = family.toLowerCase();
  return families.some((candidate) => candidate.toLowerCase() === folded);
}

function availabilityText(
  value: FontFamilyPreference,
  discovery: FontDiscoveryState,
): string {
  if (discovery.status === 'idle') {
    return value === null ? DEFAULT_COPY : 'Load installed fonts to check availability.';
  }
  if (discovery.status === 'loading') return 'Loading installed fonts…';
  if (discovery.status === 'success') {
    if (value === null) return DEFAULT_COPY;
    return includesFamily(discovery.families, value) ? AVAILABLE_COPY : FONT_COPY.unavailable;
  }
  const reason = discovery.status === 'unsupported'
    ? 'Installed font discovery is not supported.'
    : discovery.status === 'denied'
      ? 'Access to installed fonts was denied.'
      : 'Installed fonts could not be loaded.';
  return value === null ? reason : `${reason} ${FONT_COPY.unknown}`;
}


/** Renders and commits one independent UI or terminal font preference. */
export function FontControl({
  settingKey,
  label,
  value,
  fallback,
  discovery,
  onSave,
}: Props): React.JSX.Element {
  const reactId = useId();
  const inputId = `${reactId}-input`;
  const listId = `${reactId}-families`;
  const hintId = `${reactId}-hint`;
  const statusId = `${reactId}-status`;
  const errorId = `${reactId}-error`;
  const [input, setInput] = useState(value ?? '');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const pendingValueRef = useRef<FontFamilyPreference | undefined>(undefined);
  const ids = testIds(settingKey);
  const families = discovery.status === 'success' ? discovery.families : [];
  const previewStack = buildFontFamilyStack(value, fallback);

  useEffect(() => {
    pendingValueRef.current = undefined;
    setInput(value ?? '');
  }, [value]);

  async function commit(candidate: string): Promise<void> {
    if (savingRef.current) return;
    const parsed = parseFontFamilyPreference(candidate);
    if (!parsed.ok || parsed.value === null) {
      setValidationError(parsed.ok ? 'Enter a font family or use Reset.' : parsed.error);
      return;
    }
    setValidationError(null);
    setInput(parsed.value);
    if (parsed.value === value || pendingValueRef.current === parsed.value) return;
    pendingValueRef.current = parsed.value;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(parsed.value);
    } catch {
      setSaveError('Could not save this font. Your previous font remains active.');
      pendingValueRef.current = undefined;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function reset(): Promise<void> {
    if (savingRef.current || value === null || pendingValueRef.current === null) return;
    pendingValueRef.current = null;
    savingRef.current = true;
    setSaving(true);
    setValidationError(null);
    setSaveError(null);
    try {
      await onSave(null);
    } catch {
      setSaveError('Could not save this font. Your previous font remains active.');
      pendingValueRef.current = undefined;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-[--border] bg-[--panel]/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={inputId} className="text-sm font-medium">{label}</label>
        <button
          type="button"
          onClick={() => void reset()}
          disabled={saving || value === null}
          className="pressable min-h-11 rounded-md px-3 text-sm text-[--text-muted] hover:bg-[--panel-strong] hover:text-[--text] disabled:cursor-not-allowed disabled:opacity-50"
          data-testid={ids.reset}
        >
          {FONT_COPY.reset}
        </button>
      </div>
      <p id={hintId} className="text-xs text-[--text-muted]">
        Search installed fonts or enter an exact family name.
      </p>
      <input
        id={inputId}
        name={settingKey}
        type="text"
        list={listId}
        value={input}
        placeholder={FONT_COPY.defaultValue}
        autoComplete="off"
        enterKeyHint="done"
        disabled={saving}
        aria-invalid={validationError !== null}
        aria-describedby={`${hintId} ${statusId}${validationError || saveError ? ` ${errorId}` : ''}`}
        onChange={(event) => {
          const next = event.target.value;
          setInput(next);
          setValidationError(null);
          setSaveError(null);
          if (includesFamily(families, next)) void commit(next);
        }}
        onBlur={(event) => {
          if (event.currentTarget.value.length > 0 || value !== null) {
            void commit(event.currentTarget.value);
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          void commit(event.currentTarget.value);
        }}
        className="min-h-11 w-full rounded-md border border-[--input-border] bg-[--input-bg] px-3.5 py-3 text-base text-[--text] transition-colors hover:border-[--text-muted] focus-visible:ring-2 focus-visible:ring-[--accent]/70 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid={ids.input}
      />
      <datalist id={listId}>
        {families.map((family) => <option key={family} value={family} />)}
      </datalist>
      <div
        className="min-w-0 overflow-hidden rounded-md border border-[--border] bg-[--panel-strong] px-3 py-2"
        style={{ fontFamily: previewStack }}
        aria-label={`${label} preview`}
      >
        <div className="truncate text-base">
          {settingKey === 'ui_font_family'
            ? 'The quick brown fox jumps over the lazy dog.'
            : 'Terminal preview: Aa 0O 1l → ~/project'}
        </div>
        {settingKey === 'terminal_font_family' && (
          <div className="truncate text-sm text-[--text-muted]">
            Nerd Font private-use sample: <span aria-label="private-use glyph sample"> 󰆍</span>
          </div>
        )}
      </div>
      <p
        id={statusId}
        aria-live="polite"
        className="text-xs text-[--text-muted]"
        data-testid={ids.status}
      >
        {saving ? 'Saving…' : availabilityText(value, discovery)}
      </p>
      {(validationError || saveError) && (
        <p id={errorId} role="alert" className="text-xs text-[--danger]">
          {validationError ?? saveError}
        </p>
      )}
    </div>
  );
}
