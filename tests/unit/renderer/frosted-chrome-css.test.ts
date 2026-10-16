/**
 * Static guards on `frosted-chrome.css` (spec macos-frosted-chrome AC12, AC21, AC25a, plan §2.1 and §4):
 * every selector is gated on `:root[data-platform="mac"]`, the stylesheet keys on the exact `FROST_ATTR`
 * strings, no glass surface adds a `backdrop-filter` or `filter`, each glass surface token has exactly two
 * declarations (the base rule and the Reduce transparency override, which maps it to its solid source and
 * never reads the setting), and every palette block declares the same token set, so the most specific
 * matching block always decides every token.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FROST_ATTR, MAC_PLATFORM } from '@renderer/frosted-chrome-contract';

const CSS = readFileSync(
  resolve(__dirname, '../../../src/renderer/frosted-chrome.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
  readonly selectors: readonly string[];
  readonly body: string;
  readonly media: readonly string[];
}

/** Splits a selector list on the commas outside parentheses, so `:is(a, b)` stays one selector. */
function topLevelSplit(prelude: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  [...prelude].forEach((ch, i) => {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(prelude.slice(start, i).trim());
      start = i + 1;
    }
  });
  return [...parts, prelude.slice(start).trim()];
}

function rules(src: string, media: readonly string[] = []): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    let depth = 0;
    let close = open;
    for (; close < src.length; close++) {
      if (src[close] === '{') depth++;
      else if (src[close] === '}' && --depth === 0) break;
    }
    const prelude = src.slice(i, open).trim();
    const body = src.slice(open + 1, close);
    if (prelude.startsWith('@media')) out.push(...rules(body, [...media, prelude.slice(6).trim()]));
    else out.push({ selectors: topLevelSplit(prelude), body, media });
    i = close + 1;
  }
  return out;
}

const RULES = rules(CSS);
const GATE = `:root[${FROST_ATTR.platform}="${MAC_PLATFORM}"]`;
const RT = '(prefers-reduced-transparency: reduce)';
const GLASS = ['--surface-chrome', '--surface-terminal', '--surface-pane'] as const;
const SOLID_SOURCE: Record<(typeof GLASS)[number], string> = {
  '--surface-chrome': 'var(--chrome-solid)',
  '--surface-terminal': 'var(--sheet-solid)',
  '--surface-pane': 'var(--pane-solid)',
};

function decls(body: string): [string, string][] {
  return body
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]);
}

const PALETTE_SELECTORS = [
  `${GATE}, ${GATE}[data-theme="dark"]`,
  `${GATE}[data-theme="light"]`,
  `${GATE}:not([data-theme])`,
  ...['catppuccin', 'rose-pine'].flatMap((p) => [
    `${GATE}[data-palette="${p}"]`,
    `${GATE}[data-palette="${p}"][data-theme="light"]`,
    `${GATE}[data-palette="${p}"]:not([data-theme])`,
  ]),
];

const PALETTE_TOKENS = [
  '--chrome-solid',
  '--chrome-glass-alpha',
  '--sheet-solid',
  '--pane-solid',
  '--terminal-glass-alpha',
  '--chrome-text-muted',
  '--chrome-chip-text',
  '--terminal-text-muted',
  '--chrome-hue-pink',
  '--chrome-git-modified',
  '--chrome-git-added',
  '--chrome-git-deleted',
  '--chrome-git-untracked',
  '--chrome-accent-label',
  '--chrome-hue-cyan',
  '--chrome-hue-yellow',
  '--chrome-hue-purple',
  '--chrome-danger',
  '--chrome-claude-idle',
  '--chrome-claude-busy',
  '--chrome-claude-blocked',
  '--chrome-focus-ring',
  '--panel',
  '--panel-strong',
  '--chat-surface',
].sort();

function paletteBlock(selector: string): Rule {
  const found = RULES.filter((r) => r.selectors.join(', ') === selector);
  expect(found, selector).toHaveLength(1);
  return found[0] as Rule;
}

describe('frosted-chrome.css', () => {
  it('has rules to check', () => {
    expect(RULES.length).toBeGreaterThan(5);
  });

  it(`gates every selector on ${GATE} (AC25a)`, () => {
    for (const rule of RULES)
      for (const s of rule.selectors) expect(s.startsWith(GATE), s).toBe(true);
  });

  it('uses only the light colour-scheme and Reduce transparency media queries', () => {
    const queries = new Set(RULES.flatMap((r) => r.media));
    expect([...queries].sort()).toEqual(['(prefers-color-scheme: light)', RT].sort());
  });

  it('keys on the exact FROST_ATTR strings and no other data attribute besides theme, palette and the chat view', () => {
    const attrs = new Set([...CSS.matchAll(/\[(data-[\w-]+)/g)].map((m) => m[1]));
    expect([...attrs].sort()).toEqual(
      [
        FROST_ATTR.platform,
        FROST_ATTR.frostTerminal,
        FROST_ATTR.chromeRoot,
        FROST_ATTR.sheetContent,
        FROST_ATTR.overlay,
        'data-theme',
        'data-palette',
        'data-view',
      ].sort(),
    );
    expect(CSS).toContain(`[${FROST_ATTR.sheetContent}="shell"]`);
    expect(CSS).toContain(`[${FROST_ATTR.frostTerminal}]`);
    expect(CSS).toContain(`[${FROST_ATTR.chromeRoot}]`);
    expect(CSS).toContain('[data-view="chat"]');
    expect(CSS).toContain(`[${FROST_ATTR.overlay}]`);
  });

  it('adds no backdrop-filter or filter (plan §4)', () => {
    for (const rule of RULES)
      for (const [prop] of decls(rule.body))
        expect(prop, rule.selectors.join()).not.toMatch(/(^|-)filter$/);
  });

  it.each(GLASS)(
    'declares %s exactly twice: the base rule and the Reduce transparency override',
    (name) => {
      const holders = RULES.filter((r) => decls(r.body).some(([p]) => p === name));
      expect(holders.map((r) => [r.selectors.join(', '), r.media.join(' ')])).toEqual([
        [GATE, ''],
        [GATE, RT],
      ]);
    },
  );

  it('maps every glass surface to its opaque source under Reduce transparency, without reading the setting (AC12, AC21)', () => {
    const rt = RULES.filter((r) => r.media.includes(RT));
    expect(rt.map((r) => r.selectors.join(', '))).toEqual([GATE]);
    const body = new Map(decls(rt[0]?.body ?? ''));
    for (const name of GLASS) expect(body.get(name), name).toBe(SOLID_SOURCE[name]);
    expect(rt[0]?.body).not.toContain(FROST_ATTR.frostTerminal);
  });

  it('makes html and body transparent so only the app layers sit on the material', () => {
    const rule = RULES.find(
      (r) => r.selectors.includes(GATE) && r.selectors.includes(`${GATE} body`),
    );
    expect(new Map(decls(rule?.body ?? '')).get('background')).toBe('transparent');
  });

  it.each(PALETTE_SELECTORS)(
    'palette block %s declares exactly the palette token set',
    (selector) => {
      const block = paletteBlock(selector);
      expect(
        decls(block.body)
          .map(([p]) => p)
          .sort(),
      ).toEqual(PALETTE_TOKENS);
    },
  );

  it('puts the system-follow palette blocks inside the light colour-scheme query only', () => {
    for (const selector of PALETTE_SELECTORS) {
      const block = paletteBlock(selector);
      expect(block.media, selector).toEqual(
        selector.endsWith(':not([data-theme])') ? ['(prefers-color-scheme: light)'] : [],
      );
    }
  });

  it('keeps each system-follow block identical to its explicit light block', () => {
    for (const p of ['', '[data-palette="catppuccin"]', '[data-palette="rose-pine"]']) {
      expect(decls(paletteBlock(`${GATE}${p}:not([data-theme])`).body)).toEqual(
        decls(paletteBlock(`${GATE}${p}[data-theme="light"]`).body),
      );
    }
  });

  it('sets glass alphas inside the visible-effect cap (alpha <= 0.8745, D11)', () => {
    for (const selector of PALETTE_SELECTORS) {
      const body = new Map(decls(paletteBlock(selector).body));
      for (const name of ['--chrome-glass-alpha', '--terminal-glass-alpha']) {
        const a = Number(body.get(name));
        expect(a, `${selector} ${name}`).toBeGreaterThanOrEqual(0);
        expect(a, `${selector} ${name}`).toBeLessThanOrEqual(0.8745);
      }
    }
  });
});
