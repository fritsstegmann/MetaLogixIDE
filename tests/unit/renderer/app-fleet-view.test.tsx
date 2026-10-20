import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mockedModules = [
  '@renderer/api',
  '@renderer/fonts/use-apply-ui-font',
  '@renderer/hooks/useTheme',
  '@renderer/hooks/useAgentStates',
  '@renderer/hooks/useWindowTerminalFocus',
  '@renderer/hooks/useTerminalGeometryHold',
  '@renderer/hooks/useClaudePermissionMode',
  '@renderer/components/Sidebar',
  '@renderer/components/StatusBar',
  '@renderer/components/FoldPane',
  'motion/react',
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
  for (const path of mockedModules) vi.doUnmock(path);
  vi.resetModules();
});

it('restores the actual Fleet view and leaves the local sheet hidden on narrow screens', async () => {
  const saved = new Map<string, string>([['metaide.activeView', JSON.stringify('fleet')]]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
  vi.stubGlobal('window', { location: { search: '' }, api: { platform: 'darwin' } });
  vi.stubGlobal('self', {});
  vi.doMock('@renderer/api', () => ({ api: { invoke: vi.fn(), on: () => () => {} } }));
  vi.doMock('@renderer/fonts/use-apply-ui-font', () => ({ useApplyUiFont: vi.fn() }));
  vi.doMock('@renderer/hooks/useTheme', () => ({
    useTheme: () => ({
      mode: 'dark',
      effective: 'dark',
      cycle: vi.fn(),
      setMode: vi.fn(),
      setPalette: vi.fn(),
    }),
  }));
  vi.doMock('@renderer/hooks/useAgentStates', () => ({
    useProjectAgentState: () => 'idle',
    useShellAgentState: () => null,
  }));
  vi.doMock('@renderer/hooks/useWindowTerminalFocus', () => ({
    useWindowTerminalFocus: vi.fn(),
    terminalFocus: { requestProjectFocus: vi.fn() },
  }));
  vi.doMock('@renderer/hooks/useTerminalGeometryHold', () => ({
    useTerminalGeometryHold: vi.fn(),
  }));
  vi.doMock('@renderer/hooks/useClaudePermissionMode', () => ({
    useClaudePermissionMode: () => ({ status: 'chosen', mode: 'default' }),
  }));
  vi.doMock('@renderer/components/Sidebar', () => ({ Sidebar: () => null }));
  vi.doMock('@renderer/components/StatusBar', () => ({ StatusBar: () => null }));
  vi.doMock('@renderer/components/FoldPane', () => ({
    FoldPane: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  }));
  vi.doMock('motion/react', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
  }));
  // The module must load after the per-test preload bridge and theme boundaries are installed.
  const { App } = await import('@renderer/App');
  const markup = renderToStaticMarkup(createElement(App));
  expect(markup).toContain('data-view="fleet"');
  expect(markup).toContain('data-testid="fleet-panel"');
  expect(markup).toContain('Loading fleet');
  expect(markup).toMatch(/<main[^>]+hidden md:flex/);
  expect(markup).toContain('aria-label="Fleet"');
});
