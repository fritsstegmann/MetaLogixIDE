/**
 * Tree-wide icon scale check (AC2a, AC10): every renderer `.tsx` file sizes
 * its icons from ICON_SIZE and follows the stroke rule. The rules and their
 * fixtures live in icon-scale.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { iconScaleViolations } from '../../support/icon-scale';

const root = resolve(__dirname, '../../..');
const rendererDir = join(root, 'src/renderer');

function rendererFiles(): string[] {
  return readdirSync(rendererDir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => join(rendererDir, f));
}

describe('icon scale across src/renderer', () => {
  it('scans the renderer sources', () => {
    expect(rendererFiles().length).toBeGreaterThan(50);
  });

  it('has no icon off the scale or off the stroke rule', () => {
    const violations = rendererFiles().flatMap((file) => {
      const rel = relative(root, file);
      return iconScaleViolations(rel, readFileSync(file, 'utf8')).map((v) => `${rel}:${v}`);
    });
    expect(violations).toEqual([]);
  });
});
