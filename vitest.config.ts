import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
  test: {
    environment: 'node',
    // .claude/ holds mutation-test copies of the tree; dist/ and out/ hold
    // packaged builds whose bundled node_modules ship their own tests.
    exclude: ['tests/e2e/**', 'node_modules/**', '.claude/**', 'dist/**', 'out/**'],
    coverage: {
      provider: 'v8',
      all: true,
      reporter: ['json', 'text-summary'],
      reportsDirectory: '.claude/reports/project-default-agent-coverage',
      include: [
        'src/main/domain/project-default-agent.ts',
        'src/main/domain/launch.ts',
        'src/main/ipc/register.ts',
        'src/renderer/App.tsx',
        'src/renderer/main-tab.ts',
        'src/renderer/components/Sidebar.tsx',
        'src/renderer/components/ShellTabsBar.tsx',
        'src/renderer/project-default-agent-store.ts',
        'src/renderer/hooks/useProjectDefaultAgent.ts',
        'src/renderer/components/ProjectSettingsTab.tsx',
        'src/renderer/components/ProjectSettingsPanel.tsx',
      ],
    },
  },
});
