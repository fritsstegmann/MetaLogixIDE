import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildServices } from '@main/services';
import { createFleetOperations } from '@main/ipc/register';
import { AgentStatusTracker } from '@main/agent-status/state-tracker';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('local Fleet operation boundary', () => {
  it.skipIf(process.platform === 'win32')(
    'lists only public status and uses real local shell checks, PTY input, output, and stop',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'fleet-operation-'));
      roots.push(home);
      const projectPath = join(home, 'root', 'project');
      mkdirSync(projectPath, { recursive: true });
      const services = buildServices({
        homeDir: home,
        dbPath: join(home, 'state.db'),
        migrationsDir: resolve('migrations'),
      });
      const root = services.roots.add(join(home, 'root'));
      const project = services.projects.upsert(root.id, projectPath, 'Example');
      const operations = createFleetOperations(services);
      try {
        expect(await operations.status()).toEqual({
          projects: [{ id: project.id, name: 'Example' }],
          shells: [],
        });
        await expect(operations.launch(project.id + 10_000)).rejects.toThrow(/no project/);
        expect(services.ptyManager.liveShells()).toEqual([]);
        const { shellIndex } = await operations.launch(project.id);
        expect((await operations.status()).shells).toEqual([
          { projectId: project.id, shellIndex, agent: null, state: 'idle' },
        ]);
        const identity = services.ptyManager.liveShell(project.id, shellIndex);
        if (!identity) throw new Error('Local PTY identity missing');
        const tracker = new AgentStatusTracker(services.ptyManager, async () => false);
        tracker.spawn({ projectId: project.id, shellIndex, ...identity, agent: 'omp' });
        tracker.ompReport({ projectId: project.id, shellIndex }, identity.generation, 'busy');
        services.agentStatus = tracker;
        expect((await operations.status()).shells).toEqual([
          { projectId: project.id, shellIndex, agent: 'omp', state: 'busy' },
        ]);
        services.agentStatus = null;
        const activeShell = services.ptyManager.liveShells()[0];
        if (!activeShell) throw new Error('Local PTY did not start');
        vi.spyOn(services.ptyManager, 'liveShells').mockReturnValueOnce(
          Array.from({ length: 257 }, (_, index) => ({ ...activeShell, shellIndex: index })),
        );
        expect(() => operations.status()).toThrow(/256-project\/shell limit/);
        await operations.write(project.id, shellIndex, 'printf "FLEET_OPERATION_READY\\n"\n');
        await vi.waitFor(
          async () => {
            const snapshot = await operations.snapshot(project.id, shellIndex);
            expect(snapshot.alive).toBe(true);
            expect(snapshot.output).toContain('FLEET_OPERATION_READY');
          },
          { timeout: 5000 },
        );
        await operations.stop(project.id, shellIndex);
        expect((await operations.snapshot(project.id, shellIndex)).alive).toBe(false);
        expect((await operations.status()).shells).toEqual([]);
        const unicodeOutput = '🙂'.repeat(2048) + 'x';
        vi.spyOn(services.ptyManager, 'getSnapshot').mockResolvedValue(unicodeOutput);
        const clipped = await operations.snapshot(project.id, shellIndex);
        expect(clipped.output).toBe('🙂'.repeat(2046) + 'x');
        expect(Buffer.byteLength(clipped.output, 'utf8')).toBeLessThanOrEqual(8188);

        const longName = 'a'.repeat(155) + 'é'.repeat(8);
        const longProject = services.projects.upsert(root.id, join(home, 'root', 'long'), longName);
        expect(
          (await operations.status()).projects.find(({ id }) => id === longProject.id),
        ).toEqual({
          id: longProject.id,
          name: 'a'.repeat(155),
        });
        const unnamed = services.projects.upsert(root.id, join(home, 'root', 'unnamed'), '\0');
        expect((await operations.status()).projects.find(({ id }) => id === unnamed.id)).toEqual({
          id: unnamed.id,
          name: 'Unnamed project',
        });
        for (let index = 0; index < 254; index++) {
          services.projects.upsert(root.id, join(home, 'root', `extra-${index}`), `Extra ${index}`);
        }
        expect(() => operations.status()).toThrow(/256-project\/shell limit/);
      } finally {
        for (const shell of services.ptyManager.liveShells()) {
          await services.ptyManager.kill(shell.projectId, shell.shellIndex);
        }
        services.db.close();
      }
    },
  );
});
