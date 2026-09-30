/**
 * Adapter over the mermaid library behind the `DiagramRenderer` seam. Mermaid
 * is reached only through the lazy `import('mermaid')` below so it lands in
 * its own chunk, loaded on the first diagram. Renders are serialised because
 * `initialize` is global, results are cached by (theme, tokens, source), and
 * every failure comes back as a value. Diagrams get Mermaid's `base` theme
 * with the app palette derived from the live theme tokens, unless their own
 * directive or frontmatter picks a theme, in which case they get no palette.
 */
import {
  MERMAID_EMPTY_MESSAGE,
  type DiagramRenderer,
  type DiagramResult,
  type EffectiveTheme,
} from '../contract';
import { mermaidThemeVariables, withAuthorVariables } from './mermaidPalette';
import { THEME_TOKEN_NAMES, type ThemeTokens } from './paletteContract';
import { readThemeTokens } from './themeTokens';

/** What `mermaid.parse` reports: the source's own frontmatter and directive config. */
export type MermaidParseResult = { config?: { theme?: unknown; themeVariables?: unknown } } | false;

/** The narrow slice of the mermaid API this adapter uses. */
export interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  parse(text: string): Promise<MermaidParseResult>;
  render(id: string, text: string, container?: Element): Promise<{ svg: string }>;
}

export interface MermaidDeps {
  load(): Promise<MermaidApi>;
  removeNode(id: string): void;
  readTokens(): ThemeTokens;
  derive(tokens: ThemeTokens, theme: EffectiveTheme): Record<string, unknown>;
}

const CACHE_LIMIT = 50;
const PALETTE_LIMIT = 4;

const SCRATCH_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'absolute',
  top: '0',
  left: '0',
  width: '100%',
  height: '0',
  overflow: 'hidden',
  visibility: 'hidden',
};

const defaultDeps: MermaidDeps = {
  load: async () => (await import('mermaid')).default,
  removeNode: (id) => document.getElementById(id)?.remove(),
  readTokens: () => readThemeTokens(),
  derive: mermaidThemeVariables,
};

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) return String(err.message);
  return String(err);
}

/** Whether the source's own directive or frontmatter names a theme; only that key is read. */
function hasOwnTheme(parsed: MermaidParseResult): boolean {
  const config = parsed ? parsed.config : undefined;
  if (!config || !Object.hasOwn(config, 'theme')) return false;
  return typeof config.theme === 'string' && config.theme !== '';
}

/** The `initialize` config: the app palette on `base`, or no theme at all when `palette` is null. */
function mermaidConfig(palette: Record<string, unknown> | null): Record<string, unknown> {
  const base = { startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true };
  return palette ? { ...base, theme: 'base', themeVariables: palette } : base;
}

function tokenKey(tokens: ThemeTokens): string {
  return Object.keys(THEME_TOKEN_NAMES)
    .map((field) => tokens[field as keyof ThemeTokens])
    .join('\n');
}

/** Stores a result, evicting the oldest entry once the cache exceeds its bound. */
function remember<T>(cache: Map<string, T>, key: string, value: T, limit = CACHE_LIMIT): void {
  cache.set(key, value);
  const oldest = cache.keys().next();
  if (cache.size > limit && !oldest.done) cache.delete(oldest.value);
}

/**
 * Runs `mermaid.render` inside a throwaway child of `container`, removed
 * afterwards. Mermaid clears the element it is given (`innerHTML = ""`), so it
 * must never receive the block holding the diagram source or earlier output.
 * The scratch is hidden and out of flow but not `display:none`, since mermaid
 * measures text with `getBBox` while laying out.
 */
async function renderInScratch(
  mermaid: MermaidApi,
  id: string,
  source: string,
  container: Element,
): Promise<{ svg: string }> {
  const scratch = container.ownerDocument.createElement('div');
  Object.assign(scratch.style, SCRATCH_STYLE);
  container.append(scratch);
  try {
    return await mermaid.render(id, source, scratch);
  } finally {
    scratch.remove();
  }
}

/**
 * Builds a diagram renderer over mermaid. `deps.load` supplies the library
 * (called once, on the first non-empty render), `deps.removeNode` drops the
 * temporary nodes mermaid leaves behind on failure, `deps.readTokens` reads
 * the live theme tokens on every render and `deps.derive` turns them into the
 * palette (memoised per theme and token set); all are injectable for tests.
 * An unusable token fails every diagram, directive-themed ones included.
 */
export function createMermaidRenderer(deps: Partial<MermaidDeps> = {}): DiagramRenderer {
  const { load, removeNode, readTokens, derive }: MermaidDeps = { ...defaultDeps, ...deps };
  const cache = new Map<string, DiagramResult>();
  const palettes = new Map<string, Record<string, unknown>>();
  let loaded: Promise<MermaidApi> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let nextId = 0;

  function library(): Promise<MermaidApi> {
    loaded ??= load().catch((err: unknown) => {
      loaded = null;
      throw err;
    });
    return loaded;
  }

  function palette(theme: EffectiveTheme): { key: string; variables: Record<string, unknown> } {
    const tokens = readTokens();
    const key = `${theme}\n${tokenKey(tokens)}`;
    let variables = palettes.get(key);
    if (!variables) {
      variables = derive(tokens, theme);
      remember(palettes, key, variables, PALETTE_LIMIT);
    }
    return { key, variables };
  }

  async function renderNow(
    source: string,
    theme: EffectiveTheme,
    container: Element,
  ): Promise<DiagramResult> {
    let app: ReturnType<typeof palette>;
    try {
      app = palette(theme);
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
    const key = `${app.key}\n${source}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const id = `mmd${nextId++}`;
    try {
      const mermaid = await library();
      const parsed = await mermaid.parse(source);
      const author = parsed ? parsed.config?.themeVariables : undefined;
      const variables = hasOwnTheme(parsed) ? null : withAuthorVariables(app.variables, author);
      mermaid.initialize(mermaidConfig(variables));
      const { svg } = await renderInScratch(mermaid, id, source, container);
      const result: DiagramResult = { ok: true, svg };
      remember(cache, key, result);
      return result;
    } catch (err) {
      removeNode(`d${id}`);
      removeNode(id);
      return { ok: false, message: errorMessage(err) };
    }
  }

  return {
    render(source, theme, container) {
      if (source.trim() === '')
        return Promise.resolve({ ok: false, message: MERMAID_EMPTY_MESSAGE });
      const result = queue.then(() => renderNow(source, theme, container));
      queue = result;
      return result;
    },
  };
}

/** The app-wide mermaid renderer; one queue and cache for every preview. */
export const mermaidRenderer: DiagramRenderer = createMermaidRenderer();
