/**
 * Adapter over the mermaid library behind the `DiagramRenderer` seam. Mermaid
 * is reached only through the lazy `import('mermaid')` below so it lands in
 * its own chunk, loaded on the first diagram. Renders are serialised because
 * `initialize` is global, results are cached by (source, theme), and every
 * failure comes back as a value.
 */
import {
  MERMAID_EMPTY_MESSAGE,
  type DiagramRenderer,
  type DiagramResult,
  type EffectiveTheme,
} from '../contract';

/** The narrow slice of the mermaid API this adapter uses. */
export interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  parse(text: string): Promise<unknown>;
  render(id: string, text: string, container?: Element): Promise<{ svg: string }>;
}

export interface MermaidDeps {
  load(): Promise<MermaidApi>;
  removeNode(id: string): void;
}

const CACHE_LIMIT = 50;

const defaultDeps: MermaidDeps = {
  load: async () => (await import('mermaid')).default as unknown as MermaidApi,
  removeNode: (id) => document.getElementById(id)?.remove(),
};

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) return String(err.message);
  return String(err);
}

function mermaidConfig(theme: EffectiveTheme): Record<string, unknown> {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: theme === 'dark' ? 'dark' : 'default',
  };
}

/**
 * Runs `mermaid.render` inside a throwaway child of `container`, removed
 * afterwards. Mermaid clears the element it is given (`innerHTML = ""`), so it
 * must never receive the block holding the diagram source or earlier output.
 */
async function renderInScratch(
  mermaid: MermaidApi,
  id: string,
  source: string,
  container: Element,
): Promise<{ svg: string }> {
  const scratch = container.ownerDocument.createElement('div');
  container.append(scratch);
  try {
    return await mermaid.render(id, source, scratch);
  } finally {
    scratch.remove();
  }
}

/**
 * Builds a diagram renderer over mermaid. `deps.load` supplies the library
 * (called once, on the first non-empty render) and `deps.removeNode` drops
 * the temporary nodes mermaid leaves behind on failure; both are injectable
 * for tests.
 */
export function createMermaidRenderer(deps: Partial<MermaidDeps> = {}): DiagramRenderer {
  const { load, removeNode }: MermaidDeps = { ...defaultDeps, ...deps };
  const cache = new Map<string, DiagramResult>();
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

  function remember(key: string, result: DiagramResult): void {
    cache.set(key, result);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  }

  async function renderNow(
    source: string,
    theme: EffectiveTheme,
    container: Element,
  ): Promise<DiagramResult> {
    const key = `${theme}\n${source}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const id = `mmd${nextId++}`;
    try {
      const mermaid = await library();
      mermaid.initialize(mermaidConfig(theme));
      await mermaid.parse(source);
      const { svg } = await renderInScratch(mermaid, id, source, container);
      const result: DiagramResult = { ok: true, svg };
      remember(key, result);
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
