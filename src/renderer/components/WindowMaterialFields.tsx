/**
 * Settings › General "Window material" group: window opacity, backdrop blur
 * and backdrop saturation sliders plus a quiet "Reset to defaults". Values
 * load via `settings:get` and every change writes the full material through
 * `app:set-window-material`; the logic lives in `createWindowMaterialController`.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '@renderer/api';
import {
  createWindowMaterialController,
  INITIAL_MATERIAL_STATE,
  type WindowMaterialIo,
} from '@renderer/window-material-sync';
import { WINDOW_MATERIAL_RANGES, type WindowMaterial } from '@shared/window-material';

const FIELDS: ReadonlyArray<{ field: keyof WindowMaterial; label: string; step: number; unit: string; testId: string }> = [
  { field: 'opacity',    label: 'Window opacity',      step: 1, unit: '%',  testId: 'window-opacity-slider' },
  { field: 'blur',       label: 'Backdrop blur',       step: 1, unit: 'px', testId: 'window-blur-slider' },
  { field: 'saturation', label: 'Backdrop saturation', step: 5, unit: '%',  testId: 'window-saturation-slider' },
];

const io: WindowMaterialIo = {
  read: async (key) => (await api.invoke('settings:get', { key })).value,
  save: (material) => api.invoke('app:set-window-material', material),
};

/** Binds a window-material controller to component state and loads on mount. */
function useWindowMaterial() {
  const [state, setState] = useState(INITIAL_MATERIAL_STATE);
  const controller = useMemo(() => createWindowMaterialController(io, setState), []);
  useEffect(() => controller.load(), [controller]);
  return { ...state, change: controller.change, reset: controller.reset };
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
      <label htmlFor={id} className="block text-sm font-medium">{label}</label>
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
      <div role="alert" className="text-xs text-[--danger] empty:hidden">{error}</div>
    </div>
  );
}
