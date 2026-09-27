import type { DiagramRenderer } from '../contract';

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

const defaultDeps: MermaidDeps = {
  load: async () => (await import('mermaid')).default as unknown as MermaidApi,
  removeNode: (id) => document.getElementById(id)?.remove(),
};

/** Builds a diagram renderer over mermaid; deps are injectable for tests. */
export function createMermaidRenderer(deps: Partial<MermaidDeps> = {}): DiagramRenderer {
  const resolved: MermaidDeps = { ...defaultDeps, ...deps };
  return {
    async render(source, theme, container) {
      const mermaid = await resolved.load();
      void mermaid;
      void source;
      void theme;
      void container;
      throw new Error('not implemented');
    },
  };
}

export const mermaidRenderer: DiagramRenderer = createMermaidRenderer();
