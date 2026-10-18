/**
 * Pure geometry for "tile all our windows": lays out N windows as tall
 * portrait columns centred in a display work area. The main window (index 0
 * when present) gets a 1:1.5 aspect, popouts 1:2. If a natural single-row
 * division would make cells narrower than MIN_W, the layout falls back to two
 * rows of uniform columns. No Electron dependency, so it is unit-testable.
 */

/** A display work area in screen coordinates (Electron's `Display.workArea` shape). */
export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Window bounds as passed to `BrowserWindow.setBounds`. */
export type TileBounds = WorkArea;

/** Input to {@link computeTileLayout}; `hasMain` means index 0 is the main window. */
export interface TileLayoutInput {
  count: number;
  hasMain: boolean;
  workArea: WorkArea;
}

const GAP = 10;
const MIN_W = 380;
const MAIN_ASPECT = 1.5;
const POPOUT_ASPECT = 2;

function cellWidths({ count, hasMain }: TileLayoutInput, cellH: number): number[] {
  return Array.from({ length: count }, (_, i) =>
    Math.floor(cellH / (hasMain && i === 0 ? MAIN_ASPECT : POPOUT_ASPECT)),
  );
}

function centredOrigin(area: WorkArea, totalW: number, totalH: number): { x: number; y: number } {
  return {
    x: area.x + Math.max(0, Math.floor((area.width - totalW) / 2)),
    y: area.y + Math.max(0, Math.floor((area.height - totalH) / 2)),
  };
}

function singleRowLayout(input: TileLayoutInput): TileBounds[] {
  const cellH = input.workArea.height - GAP * 2;
  const widths = cellWidths(input, cellH);
  const totalW = widths.reduce((a, b) => a + b, 0) + (input.count + 1) * GAP;
  const origin = centredOrigin(input.workArea, totalW, cellH + GAP * 2);
  let x = origin.x + GAP;
  return widths.map((width) => {
    const bounds = { x, y: origin.y + GAP, width, height: cellH };
    x += width + GAP;
    return bounds;
  });
}

function twoRowLayout(input: TileLayoutInput): TileBounds[] {
  const rows = 2;
  const cols = Math.ceil(input.count / rows);
  const cellH = Math.floor((input.workArea.height - GAP * (rows + 1)) / rows);
  const cellW = Math.max(...cellWidths(input, cellH));
  const totalW = cols * cellW + (cols + 1) * GAP;
  const origin = centredOrigin(input.workArea, totalW, rows * cellH + (rows + 1) * GAP);
  return Array.from({ length: input.count }, (_, i) => ({
    x: origin.x + GAP + (i % cols) * (cellW + GAP),
    y: origin.y + GAP + Math.floor(i / cols) * (cellH + GAP),
    width: cellW,
    height: cellH,
  }));
}

/**
 * Computes one bounds rectangle per window, in input order (main first when
 * `hasMain`). Returns an empty array for `count === 0`.
 */
export function computeTileLayout(input: TileLayoutInput): TileBounds[] {
  if (input.count === 0) return [];
  const naturalSingleRow = Math.floor(
    (input.workArea.width - GAP * (input.count + 1)) / input.count,
  );
  return naturalSingleRow < MIN_W ? twoRowLayout(input) : singleRowLayout(input);
}
