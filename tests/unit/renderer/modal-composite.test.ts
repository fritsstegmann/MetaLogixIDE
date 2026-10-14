/**
 * Smoke test for the shared modal contrast model: it must reproduce cells of the D1T design table
 * (`.claude/reports/design-final.md`, "Contrast"), so the AC23 and AC7 tests that build on it
 * measure what the design measured.
 */
import { describe, it, expect } from 'vitest';
import { mix, modalSurface, over, ratio, reducedSurface, rgba, solid, unders, type ModalParams, type ThemeColours } from './helpers/modal-composite';

const DARK: ModalParams = { scrimAlpha: 0.4, scrimDarken: 0.6, lift: 0.06, panelAlpha: 0.78 };
const LIGHT: ModalParams = { scrimAlpha: 0.3, scrimDarken: 1, lift: 0.5, panelAlpha: 0.8 };

const defaultDark: ThemeColours = { dark: true, bg: rgba(22, 26, 34, 0.55), panelStrong: rgba(34, 38, 46, 0.92) };
const rosePineLight: ThemeColours = { dark: false, bg: solid('#faf4ed'), panelStrong: solid('#f2e9e1') };

describe('modal contrast model', () => {
  it('reproduces default-dark text over --bg (11.83)', () => {
    const surface = modalSurface(defaultDark, DARK, unders(defaultDark).bg);
    expect(ratio(solid('#e6edf3'), surface)).toBeCloseTo(11.83, 1);
  });

  it('reproduces rose-pine-light highlighted row over --panel-strong (4.82)', () => {
    const surface = modalSurface(rosePineLight, LIGHT, unders(rosePineLight).panelStrong);
    const row = over({ c: solid('#286983').c, a: 0.22 }, surface);
    expect(ratio(solid('#575279'), row)).toBeCloseTo(4.82, 1);
  });

  it('reproduces rose-pine-light muted text over --panel-strong (4.96) and reduced transparency (5.03)', () => {
    const muted = mix(solid('#575279'), solid('#797593'), 0.45);
    const base = unders(rosePineLight).panelStrong;
    expect(ratio(muted, modalSurface(rosePineLight, LIGHT, base))).toBeCloseTo(4.96, 1);
    expect(ratio(muted, reducedSurface(rosePineLight, LIGHT, base))).toBeCloseTo(5.03, 1);
  });
});
