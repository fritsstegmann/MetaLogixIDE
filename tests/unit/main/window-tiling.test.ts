import { describe, it, expect } from 'vitest';
import { computeTileLayout, type TileBounds, type WorkArea } from '@main/window-tiling';

const FHD: WorkArea = { x: 0, y: 0, width: 1920, height: 1080 };

function box(x: number, y: number, width: number, height: number): TileBounds {
  return { x, y, width, height };
}

describe('computeTileLayout — characterisation of the pre-refactor tileAllOurWindows geometry', () => {
  it('returns no bounds for zero windows', () => {
    expect(computeTileLayout({ count: 0, hasMain: false, workArea: FHD })).toEqual([]);
    expect(computeTileLayout({ count: 0, hasMain: true, workArea: FHD })).toEqual([]);
  });

  it('centres a lone main window at the 1:1.5 aspect', () => {
    expect(computeTileLayout({ count: 1, hasMain: true, workArea: FHD })).toEqual([
      box(607, 10, 706, 1060),
    ]);
  });

  it('centres a lone popout at the 1:2 aspect when main is absent', () => {
    expect(computeTileLayout({ count: 1, hasMain: false, workArea: FHD })).toEqual([
      box(695, 10, 530, 1060),
    ]);
  });

  it('lays main plus popouts side by side in one row, main first and wider', () => {
    expect(computeTileLayout({ count: 3, hasMain: true, workArea: FHD })).toEqual([
      box(67, 10, 706, 1060),
      box(783, 10, 530, 1060),
      box(1323, 10, 530, 1060),
    ]);
  });

  it('lays popouts only in one row at uniform width', () => {
    expect(computeTileLayout({ count: 3, hasMain: false, workArea: FHD })).toEqual([
      box(155, 10, 530, 1060),
      box(695, 10, 530, 1060),
      box(1235, 10, 530, 1060),
    ]);
  });

  it('clamps the row origin to the work-area edge when the row overflows it', () => {
    expect(computeTileLayout({ count: 4, hasMain: true, workArea: FHD })).toEqual([
      box(10, 10, 706, 1060),
      box(726, 10, 530, 1060),
      box(1266, 10, 530, 1060),
      box(1806, 10, 530, 1060),
    ]);
  });

  it('falls back to two rows for an odd count with main, columns sized to the main width', () => {
    expect(computeTileLayout({ count: 5, hasMain: true, workArea: FHD })).toEqual([
      box(425, 10, 350, 525),
      box(785, 10, 350, 525),
      box(1145, 10, 350, 525),
      box(425, 545, 350, 525),
      box(785, 545, 350, 525),
    ]);
  });

  it('falls back to two rows for an even count without main', () => {
    expect(computeTileLayout({ count: 6, hasMain: false, workArea: FHD })).toEqual([
      box(557, 10, 262, 525),
      box(829, 10, 262, 525),
      box(1101, 10, 262, 525),
      box(557, 545, 262, 525),
      box(829, 545, 262, 525),
      box(1101, 545, 262, 525),
    ]);
  });

  it('falls back to two rows for an even count with main on an offset work area', () => {
    const workArea: WorkArea = { x: 100, y: 25, width: 1440, height: 875 };
    expect(computeTileLayout({ count: 4, hasMain: true, workArea })).toEqual([
      box(534, 35, 281, 422),
      box(825, 35, 281, 422),
      box(534, 467, 281, 422),
      box(825, 467, 281, 422),
    ]);
  });

  it('falls back to two rows for an odd count without main on a narrow work area', () => {
    const workArea: WorkArea = { x: 0, y: 0, width: 1100, height: 800 };
    expect(computeTileLayout({ count: 3, hasMain: false, workArea })).toEqual([
      box(353, 10, 192, 385),
      box(555, 10, 192, 385),
      box(353, 405, 192, 385),
    ]);
  });

  it('uses the two-row geometry even for a single window when the work area is narrower than MIN_W', () => {
    const workArea: WorkArea = { x: 0, y: 0, width: 300, height: 600 };
    expect(computeTileLayout({ count: 1, hasMain: false, workArea })).toEqual([
      box(79, 10, 142, 285),
    ]);
  });

  it('switches to two rows exactly when the natural single-row cell drops below 380', () => {
    const atLimit: WorkArea = { x: 0, y: 0, width: 4 * 380 + 5 * 10, height: 1080 };
    const belowLimit: WorkArea = { ...atLimit, width: atLimit.width - 1 };
    expect(
      computeTileLayout({ count: 4, hasMain: false, workArea: atLimit }).every((b) => b.y === 10),
    ).toBe(true);
    expect(
      computeTileLayout({ count: 4, hasMain: false, workArea: belowLimit }).map((b) => b.y),
    ).toEqual([10, 10, 545, 545]);
  });

  it('offsets a single row by a non-zero (negative) work-area origin', () => {
    const workArea: WorkArea = { x: -1920, y: 23, width: 1920, height: 1057 };
    expect(computeTileLayout({ count: 2, hasMain: true, workArea })).toEqual([
      box(-1570, 33, 691, 1037),
      box(-869, 33, 518, 1037),
    ]);
  });
});
