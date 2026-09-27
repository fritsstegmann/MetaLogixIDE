/**
 * Settings › General "Window material" group: window opacity, backdrop blur
 * and backdrop saturation sliders plus a quiet "Reset to defaults". Values
 * load via `settings:get` and every change writes the full material through
 * `app:set-window-material` with at most one request in flight.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { createLatestWinsSender } from '@renderer/window-material-sync';
import {
  DEFAULT_WINDOW_MATERIAL,
  WINDOW_MATERIAL_RANGES,
  WINDOW_MATERIAL_SETTING_KEYS,
  type WindowMaterial,
} from '@shared/window-material';

type MaterialField = keyof WindowMaterial;

const FIELDS: ReadonlyArray<{ field: MaterialField; label: string; step: number; unit: string; testId: string }> = [
  { field: 'opacity',    label: 'Window opacity',      step: 1, unit: '%',  testId: 'window-opacity-slider' },
  { field: 'blur',       label: 'Backdrop blur',       step: 1, unit: 'px', testId: 'window-blur-slider' },
  { field: 'saturation', label: 'Backdrop saturation', step: 5, unit: '%',  testId: 'window-saturation-slider' },
];

function errorText(e: unknown): string {
  return String(e).replace(/^Error:\s*/, '');
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

async function loadMaterial(): Promise<WindowMaterial> {
  const read = (field: MaterialField) => api.invoke('settings:get', { key: WINDOW_MATERIAL_SETTING_KEYS[field] });
  const [opacity, blur, saturation] = await Promise.all([read('opacity'), read('blur'), read('saturation')]);
  return {
    opacity: numberOr(opacity.value, DEFAULT_WINDOW_MATERIAL.opacity),
    blur: numberOr(blur.value, DEFAULT_WINDOW_MATERIAL.blur),
    saturation: numberOr(saturation.value, DEFAULT_WINDOW_MATERIAL.saturation),
  };
}

/**
 * Local state for the group: `material` (defaults until the first load
 * settles), `loaded`, `error` (last load or save failure as display text),
 * `change(field, value)` and `reset()`, both applied optimistically and
 * written as a full material; the normalised response replaces local state.
 */
function useWindowMaterial() {
  const [material, setMaterial] = useState<WindowMaterial>(DEFAULT_WINDOW_MATERIAL);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(material);

  const commit = useCallback((next: WindowMaterial) => {
    current.current = next;
    setMaterial(next);
  }, []);

  const push = useMemo(() => createLatestWinsSender(
    (next: WindowMaterial) => api.invoke('app:set-window-material', next),
    (saved) => { setError(null); commit(saved); },
    (e) => { console.error('window material save failed', e); setError(errorText(e)); },
  ), [commit]);

  useEffect(() => {
    let live = true;
    loadMaterial().then(
      (m) => { if (live) { commit(m); setLoaded(true); } },
      (e: unknown) => { console.error('window material load failed', e); if (live) { setError(errorText(e)); setLoaded(true); } },
    );
    return () => { live = false; };
  }, [commit]);

  const write = useCallback((next: WindowMaterial) => { commit(next); push(next); }, [commit, push]);
  const change = useCallback((field: MaterialField, value: number) => write({ ...current.current, [field]: value }), [write]);
  const reset = useCallback(() => write(DEFAULT_WINDOW_MATERIAL), [write]);

  return { material, loaded, error, change, reset };
}

interface MaterialSliderProps {
  label: string;
  range: { readonly min: number; readonly max: number };
  step: number;
  unit: string;
  value: number;
  disabled: boolean;
  testId: string;
  onChange: (value: number) => void;
}

/** One labelled range input with its monospace value readout. */
function MaterialSlider({ label, range, step, unit, value, disabled, testId, onChange }: MaterialSliderProps) {
  const id = `${testId}-input`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm">{label}</label>
      <div className="flex items-center gap-3">
        <input
          id={id}
          type="range"
          min={range.min}
          max={range.max}
          step={step}
          value={value}
          disabled={disabled}
          aria-valuetext={`${value}${unit}`}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1 accent-[--accent] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[--accent] rounded"
          data-testid={testId}
        />
        <span className="w-14 text-right text-sm text-[--text] font-mono" aria-hidden="true">{value}{unit}</span>
      </div>
    </div>
  );
}

/** Settings › General: window opacity, backdrop blur, backdrop saturation, reset. */
export function WindowMaterialFields(): JSX.Element {
  const { material, loaded, error, change, reset } = useWindowMaterial();
  return (
    <div role="group" aria-labelledby="window-material-title" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div id="window-material-title" className="text-sm font-medium">Window material</div>
        <button
          type="button"
          onClick={reset}
          disabled={!loaded}
          className="text-xs text-[--text-muted] hover:text-[--text] hover:underline underline-offset-2 px-2 py-1 rounded-md disabled:opacity-50"
          data-testid="window-material-reset"
        >
          Reset to defaults
        </button>
      </div>
      <div className="text-xs text-[--text-muted]">
        Blur and saturation shape the frosted glass of the app&apos;s translucent surfaces (menus, sidebars, bars).
      </div>
      {FIELDS.map(({ field, label, step, unit, testId }) => (
        <MaterialSlider
          key={field}
          label={label}
          range={WINDOW_MATERIAL_RANGES[field]}
          step={step}
          unit={unit}
          value={material[field]}
          disabled={!loaded}
          testId={testId}
          onChange={(v) => change(field, v)}
        />
      ))}
      {error && <div role="alert" className="text-xs text-[--danger]">{error}</div>}
    </div>
  );
}
