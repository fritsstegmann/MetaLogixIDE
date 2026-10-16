import type { ChangeEvent } from 'react';
import { FROSTED_GLASS_COPY, FROSTED_GLASS_TESTIDS } from '@renderer/frosted-chrome-contract';
import { CHROME_FROST_LEVELS, TERMINAL_FROST_LEVELS, VIBRANCY_MATERIALS } from '@shared/frosted-glass';
import { useFrostedGlassSettings } from '@renderer/hooks/useFrostedGlassSettings';
import { usePrefersReducedTransparency } from '@renderer/hooks/usePrefersReducedTransparency';
import { Switch } from '@renderer/components/settings/primitives';
import { SegmentedRadioGroup } from '@renderer/components/settings/SegmentedRadioGroup';

const ROW_LABEL = 'text-[13px] font-medium text-[--text]';
const HINT = 'text-xs text-[--text-muted]';

/**
 * Settings > General > Appearance "Frosted glass" group, rendered on macOS only (D21, AC26):
 * Frosted chrome switch, Chrome frost and Terminal frost radiogroups, and the Material select,
 * in that order. It owns its state through `useFrostedGlassSettings`; the level radiogroups stay
 * readable but disabled with "Needs Frosted chrome" (AC9) while Frosted chrome is off, and a
 * `usePrefersReducedTransparency` line (D12, AC24) explains that the system keeps surfaces solid.
 */
export function FrostedGlassGroup() {
  const { values, setFrostChrome, setChromeFrostLevel, setTerminalFrostLevel, setVibrancyMaterial } =
    useFrostedGlassSettings();
  const reduceTransparency = usePrefersReducedTransparency();
  const headingId = `${FROSTED_GLASS_TESTIDS.group}-heading`;
  const materialId = `${FROSTED_GLASS_TESTIDS.material}-label`;
  const levelsDisabled = !values.frostChrome;

  return (
    <div role="group" aria-labelledby={headingId} data-testid={FROSTED_GLASS_TESTIDS.group} className="flex flex-col gap-3.5">
      <div id={headingId} className={ROW_LABEL}>{FROSTED_GLASS_COPY.group}</div>

      <div className="flex flex-col gap-1">
        <Switch
          label={FROSTED_GLASS_COPY.frostChrome}
          ariaLabel={FROSTED_GLASS_COPY.frostChrome}
          testId={FROSTED_GLASS_TESTIDS.frostChrome}
          checked={values.frostChrome}
          onChange={(next) => void setFrostChrome(next)}
        />
        <span className={HINT}>{FROSTED_GLASS_COPY.frostChromeHint}</span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className={ROW_LABEL}>{FROSTED_GLASS_COPY.chromeFrost}</span>
        <div className="flex flex-col items-end gap-1">
          <SegmentedRadioGroup
            label={FROSTED_GLASS_COPY.chromeFrost}
            options={CHROME_FROST_LEVELS}
            labels={FROSTED_GLASS_COPY.levels}
            value={values.chromeFrostLevel}
            disabled={levelsDisabled}
            testId={FROSTED_GLASS_TESTIDS.chromeFrost}
            onChange={(next) => void setChromeFrostLevel(next)}
          />
          {levelsDisabled && <span className={HINT}>{FROSTED_GLASS_COPY.disabledReason}</span>}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className={ROW_LABEL}>{FROSTED_GLASS_COPY.terminalFrost}</span>
        <div className="flex flex-col items-end gap-1">
          <SegmentedRadioGroup
            label={FROSTED_GLASS_COPY.terminalFrost}
            options={TERMINAL_FROST_LEVELS}
            labels={FROSTED_GLASS_COPY.levels}
            value={values.terminalFrostLevel}
            disabled={levelsDisabled}
            testId={FROSTED_GLASS_TESTIDS.terminalFrost}
            onChange={(next) => void setTerminalFrostLevel(next)}
          />
          {levelsDisabled && <span className={HINT}>{FROSTED_GLASS_COPY.disabledReason}</span>}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col">
          <label htmlFor={materialId} className={ROW_LABEL}>{FROSTED_GLASS_COPY.material}</label>
          <span className={HINT}>{FROSTED_GLASS_COPY.materialHint}</span>
        </div>
        <select
          id={materialId}
          data-testid={FROSTED_GLASS_TESTIDS.material}
          value={values.vibrancyMaterial}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => void setVibrancyMaterial(e.target.value as typeof values.vibrancyMaterial)}
          className="h-[34px] rounded-[9px] bg-[--surface-field] px-2.5 text-[13px] text-[--text] focus:outline-none focus:ring-2 focus:ring-[--accent]/60 focus-visible:rounded-[9px]"
        >
          {VIBRANCY_MATERIALS.map((material) => (
            <option key={material} value={material}>{FROSTED_GLASS_COPY.materials[material]}</option>
          ))}
        </select>
      </div>

      {reduceTransparency && (
        <p data-testid={FROSTED_GLASS_TESTIDS.reduceTransparency} className={HINT}>
          {FROSTED_GLASS_COPY.reduceTransparency}
        </p>
      )}
    </div>
  );
}
