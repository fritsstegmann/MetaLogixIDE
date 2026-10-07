import { describe, expect, it } from 'vitest';
import {
  FOLD_LABELS,
  paneFoldTarget,
  paneFoldVariants,
  type FoldCustom,
  type FoldPhase,
  type FoldTarget,
} from '@renderer/pane-fold';
import { PANE_EASE, PANE_ENTER_S, PANE_EXIT_S, REDUCED_FADE_S } from '@renderer/motion-tokens';

const NORMAL: FoldCustom = { instant: false, reduced: false };
const INSTANT: FoldCustom = { instant: true, reduced: false };
const REDUCED: FoldCustom = { instant: false, reduced: true };
const REDUCED_INSTANT: FoldCustom = { instant: true, reduced: true };
const PHASES: FoldPhase[] = ['initial', 'enter', 'exit'];

type Tween = { duration?: number; delay?: number; ease?: unknown };

function tweenOf(t: FoldTarget, key: string): Tween {
  const tr = (t.transition ?? {}) as Record<string, unknown>;
  return (tr[key] ?? tr) as Tween;
}

/** Progress of a CSS cubic-bezier(x1, y1, x2, y2) at time fraction x, solved by bisection. */
function bezierAt([x1, y1, x2, y2]: readonly [number, number, number, number], x: number): number {
  const curve = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (curve(x1, x2, mid) < x) lo = mid; else hi = mid;
  }
  return curve(y1, y2, (lo + hi) / 2);
}

function keysDeep(v: unknown): string[] {
  if (v === null || typeof v !== 'object') return [];
  return Object.entries(v).flatMap(([k, inner]) => [k, ...keysDeep(inner)]);
}

describe('pane fold timing tokens', () => {
  it('closes within 180–320ms and opens within 320ms (AC43)', () => {
    expect(PANE_EXIT_S).toBeGreaterThanOrEqual(0.18);
    expect(PANE_EXIT_S).toBeLessThanOrEqual(0.32);
    expect(PANE_ENTER_S).toBeLessThanOrEqual(0.32);
  });

  it('uses an even curve: 30–70% done at half time (AC43)', () => {
    const half = bezierAt(PANE_EASE, 0.5);
    expect(half).toBeGreaterThanOrEqual(0.3);
    expect(half).toBeLessThanOrEqual(0.7);
  });

  it('never moves more than 12.5% in one 60Hz frame at the close duration (AC42 margin)', () => {
    const frames = Math.ceil((PANE_EXIT_S * 1000) / (1000 / 60));
    let largest = 0;
    for (let i = 1; i <= frames; i++) {
      const prev = bezierAt(PANE_EASE, Math.min(1, (i - 1) / frames));
      const next = bezierAt(PANE_EASE, Math.min(1, i / frames));
      largest = Math.max(largest, next - prev);
    }
    expect(largest).toBeLessThanOrEqual(0.125);
  });

  it('fades for at least 150ms under reduced motion (AC56)', () => {
    expect(REDUCED_FADE_S).toBeGreaterThanOrEqual(0.15);
  });
});

describe('paneFoldTarget, normal motion', () => {
  it('starts an enter folded at 0', () => {
    expect(paneFoldTarget('initial', NORMAL)['--fold']).toBe(0);
  });

  it('unfolds to 1 over the enter duration on the pane curve', () => {
    const t = paneFoldTarget('enter', NORMAL);
    expect(t['--fold']).toBe(1);
    expect(tweenOf(t, '--fold')).toMatchObject({ duration: PANE_ENTER_S, ease: PANE_EASE });
    expect(tweenOf(t, '--fold').delay ?? 0).toBe(0);
  });

  it('folds to 0 over the exit duration on the pane curve', () => {
    const t = paneFoldTarget('exit', NORMAL);
    expect(t['--fold']).toBe(0);
    expect(tweenOf(t, '--fold')).toMatchObject({ duration: PANE_EXIT_S, ease: PANE_EASE });
    expect(tweenOf(t, '--fold').delay ?? 0).toBe(0);
  });

  it('never touches opacity, so nothing fades or rests below 1', () => {
    for (const phase of PHASES) expect(paneFoldTarget(phase, NORMAL)).not.toHaveProperty('opacity');
  });
});

describe('paneFoldTarget, instant (keyboard toggles, AC49)', () => {
  for (const custom of [INSTANT, REDUCED_INSTANT]) {
    const label = custom.reduced ? 'with reduced motion' : 'with full motion';

    it(`mounts unfolded and changes in one step ${label}`, () => {
      expect(paneFoldTarget('initial', custom)['--fold']).toBe(1);
      const enter = paneFoldTarget('enter', custom);
      const exit = paneFoldTarget('exit', custom);
      expect(enter['--fold']).toBe(1);
      expect(exit['--fold']).toBe(0);
      expect(tweenOf(enter, '--fold')).toMatchObject({ duration: 0 });
      expect(tweenOf(exit, '--fold')).toMatchObject({ duration: 0 });
      expect(tweenOf(exit, '--fold').delay ?? 0).toBe(0);
    });

    it(`does not fade ${label}`, () => {
      for (const phase of PHASES) expect(paneFoldTarget(phase, custom)).not.toHaveProperty('opacity');
    });
  }
});

describe('paneFoldTarget, reduced motion (AC55–AC57)', () => {
  it('mounts at full size and transparent', () => {
    expect(paneFoldTarget('initial', REDUCED)).toMatchObject({ '--fold': 1, opacity: 0 });
  });

  it('enters by fading in place: layout in one step, opacity over ≥150ms', () => {
    const t = paneFoldTarget('enter', REDUCED);
    expect(t).toMatchObject({ '--fold': 1, opacity: 1 });
    expect(tweenOf(t, '--fold')).toMatchObject({ duration: 0 });
    expect(tweenOf(t, 'opacity').duration).toBeGreaterThanOrEqual(0.15);
    expect(tweenOf(t, 'opacity').delay ?? 0).toBe(0);
  });

  it('exits by fading at full size, then collapsing in one step after the fade', () => {
    const t = paneFoldTarget('exit', REDUCED);
    expect(t).toMatchObject({ '--fold': 0, opacity: 0 });
    const fade = tweenOf(t, 'opacity');
    expect(fade.duration).toBeGreaterThanOrEqual(0.15);
    expect(fade.delay ?? 0).toBe(0);
    expect(tweenOf(t, '--fold')).toMatchObject({ duration: 0, delay: fade.duration });
  });
});

describe('paneFoldVariants', () => {
  it('resolves every phase through the custom flags', () => {
    for (const custom of [NORMAL, INSTANT, REDUCED, REDUCED_INSTANT]) {
      for (const phase of PHASES) {
        const variant = paneFoldVariants[FOLD_LABELS[phase]];
        expect(typeof variant).toBe('function');
        expect((variant as (c: FoldCustom) => unknown)(custom)).toEqual(paneFoldTarget(phase, custom));
      }
    }
  });

  it('never animates clip, transform, position, width or layout (AC39, AC46, AC55)', () => {
    const forbidden = ['clipPath', 'clip-path', 'transform', 'x', 'y', 'scale', 'width', 'height', 'layout'];
    for (const custom of [NORMAL, INSTANT, REDUCED, REDUCED_INSTANT]) {
      for (const phase of PHASES) {
        const keys = keysDeep(paneFoldTarget(phase, custom));
        for (const k of forbidden) expect(keys).not.toContain(k);
      }
    }
  });
});
