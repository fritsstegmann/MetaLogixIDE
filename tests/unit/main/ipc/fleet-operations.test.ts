import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Server as TlsServer } from 'node:tls';
import type { IpcMain } from 'electron';
import { buildServices } from '@main/services';
import { createFleetOperations, registerIpc } from '@main/ipc/register';
import { AgentStatusTracker } from '@main/agent-status/state-tracker';
import { FleetService } from '@main/fleet/service';
import { FleetDiscovery } from '@main/fleet/discovery';
import type { FleetKeychain } from '@main/fleet/identity';

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

describe('registered Fleet IPC over two real services', () => {
  it.skipIf(process.platform === 'win32')(
    'denies unlinked calls, then controls a linked remote PTY and revokes access',
    async () => {
      const homeA = mkdtempSync(join(tmpdir(), 'fleet-ipc-a-'));
      const homeB = mkdtempSync(join(tmpdir(), 'fleet-ipc-b-'));
      roots.push(homeA, homeB);
      const projectPath = join(homeB, 'root', 'remote');
      mkdirSync(projectPath, { recursive: true });
      const a = buildServices({
        homeDir: homeA,
        dbPath: join(homeA, 'state.db'),
        migrationsDir: resolve('migrations'),
      });
      const b = buildServices({
        homeDir: homeB,
        dbPath: join(homeB, 'state.db'),
        migrationsDir: resolve('migrations'),
      });
      const root = b.roots.add(join(homeB, 'root'));
      const project = b.projects.upsert(root.id, projectPath, 'Remote project');
      const credentials = new Map<string, string>();
      const keychain: FleetKeychain = {
        getPassword: async (service, account) => credentials.get(`${service}:${account}`) ?? null,
        setPassword: async (service, account, password) => {
          credentials.set(`${service}:${account}`, password);
        },
      };
      const local = new FleetService({
        name: 'Local IDE',
        storageDir: join(homeA, 'fleet'),
        operations: createFleetOperations(a),
        keychain,
      });
      const remote = new FleetService({
        name: 'Remote IDE',
        storageDir: join(homeB, 'fleet'),
        operations: createFleetOperations(b),
        keychain,
      });
      a.fleet = local;
      b.fleet = remote;
      const channels = new Map<string, (...args: unknown[]) => unknown>();
      registerIpc(
        {
          handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
            channels.set(channel, handler);
          },
        } as unknown as IpcMain,
        a,
        vi.fn(),
      );
      const invoke = async (channel: string, req: unknown): Promise<unknown> => {
        const handler = channels.get(channel);
        if (!handler) throw new Error(`IPC channel unavailable: ${channel}`);
        return handler({ sender: {} }, req);
      };
      const announce = (receiver: FleetService, sender: FleetService, name: string): void => {
        const discovery: unknown = Reflect.get(receiver, 'discovery');
        const server: unknown = Reflect.get(sender, 'server');
        const identity: unknown = Reflect.get(sender, 'identity');
        if (
          !(discovery instanceof FleetDiscovery) ||
          !(server instanceof TlsServer) ||
          !identity ||
          typeof identity !== 'object' ||
          !('id' in identity) ||
          typeof identity.id !== 'string'
        )
          throw new Error('Live discovery or TLS identity missing');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Listener unavailable');
        // Only the public beacon is injected; pair and all control calls use actual TLS.
        discovery.observe(
          Buffer.from(JSON.stringify({ v: 1, id: identity.id, name, port: address.port })),
          '127.0.0.1',
        );
      };
      try {
        await local.start();
        await remote.start();
        expect(await invoke('fleet:get-state', undefined)).toMatchObject({ enabled: false });
        await invoke('fleet:set-enabled', { enabled: true });
        await remote.setEnabled(true);
        announce(local, remote, 'Remote IDE');
        announce(remote, local, 'Local IDE');
        const peer = local.state().peers.find(({ name }) => name === 'Remote IDE');
        const opposite = remote.state().peers.find(({ name }) => name === 'Local IDE');
        if (!peer || !opposite) throw new Error('Both peers must be discovered');
        await expect(invoke('fleet:status', { peerId: peer.id })).rejects.toThrow();
        await expect(
          invoke('fleet:write', {
            peerId: peer.id,
            projectId: project.id,
            shellIndex: 0,
            data: 'echo never\\r',
          }),
        ).rejects.toThrow();
        await invoke('fleet:pair', { peerId: peer.id });
        await vi.waitFor(() => {
          expect(local.state().peers.find(({ id }) => id === peer.id)?.status).toBe('pending');
          expect(remote.state().peers.find(({ id }) => id === opposite.id)?.status).toBe('pending');
        });
        const code = local.state().peers.find(({ id }) => id === peer.id)?.verificationCode;
        expect(code).toBe(
          remote.state().peers.find(({ id }) => id === opposite.id)?.verificationCode,
        );
        if (!code) throw new Error('Pairing code missing');
        await invoke('fleet:approve', { peerId: peer.id, verificationCode: code });
        await remote.approve(opposite.id, code);
        await vi.waitFor(() =>
          expect(local.state().peers.find(({ id }) => id === peer.id)?.status).toBe('linked'),
        );
        expect(await invoke('fleet:status', { peerId: peer.id })).toMatchObject({
          projects: [{ id: project.id, name: 'Remote project' }],
        });
        const launched = await invoke('fleet:launch', { peerId: peer.id, projectId: project.id });
        if (
          !launched ||
          typeof launched !== 'object' ||
          !('shellIndex' in launched) ||
          typeof launched.shellIndex !== 'number'
        )
          throw new Error('Remote shell did not launch');
        const shellIndex = launched.shellIndex;
        await invoke('fleet:write', {
          peerId: peer.id,
          projectId: project.id,
          shellIndex,
          data: 'printf "FLEET_IPC_READY\\n"\n',
        });
        await vi.waitFor(async () =>
          expect(
            await invoke('fleet:snapshot', { peerId: peer.id, projectId: project.id, shellIndex }),
          ).toMatchObject({ alive: true, output: expect.stringContaining('FLEET_IPC_READY') }),
        );
        await invoke('fleet:stop', { peerId: peer.id, projectId: project.id, shellIndex });
        expect(
          await invoke('fleet:snapshot', { peerId: peer.id, projectId: project.id, shellIndex }),
        ).toMatchObject({ alive: false });
        await invoke('fleet:revoke', { peerId: peer.id });
        await expect(invoke('fleet:status', { peerId: peer.id })).rejects.toThrow();
      } finally {
        for (const shell of b.ptyManager.liveShells()) {
          await b.ptyManager.kill(shell.projectId, shell.shellIndex);
        }
        await local.stop();
        await remote.stop();
        a.db.close();
        b.db.close();
      }
    },
    45_000,
  );
});
