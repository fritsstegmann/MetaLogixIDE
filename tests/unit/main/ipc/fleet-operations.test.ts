import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Server as TlsServer } from 'node:tls';
import type { IpcMain } from 'electron';
import { buildServices } from '@main/services';
import { createFleetOperations, fleetGitSummary, registerIpc } from '@main/ipc/register';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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
          roots: [{ id: root.id, name: 'root' }],
          projects: [{ id: project.id, rootId: root.id, name: 'Example' }],
          shells: [],
        });
        const secondPath = join(home, 'private', 'second-root');
        mkdirSync(secondPath, { recursive: true });
        const secondRoot = services.roots.add(secondPath);
        const secondProject = services.projects.upsert(
          secondRoot.id, join(secondPath, 'another'), 'Another',
        );
        expect(await operations.status()).toMatchObject({
          roots: [{ id: root.id, name: 'root' }, { id: secondRoot.id, name: 'second-root' }],
          projects: [
            { id: secondProject.id, rootId: secondRoot.id, name: 'Another' },
            { id: project.id, rootId: root.id, name: 'Example' },
          ],
        });
        expect(JSON.stringify(await operations.status())).not.toContain(home);
        const storedRoot = services.roots.list()[0];
        if (!storedRoot) throw new Error('Fixture root missing');
        vi.spyOn(services.roots, 'list').mockReturnValueOnce(
          Array.from({ length: 257 }, (_, index) => ({ ...storedRoot, id: index + 1 })),
        );
        expect(() => operations.status()).toThrow(/256-root\/project\/shell limit/);
        await expect(operations.launch(project.id + 10_000)).rejects.toThrow(/no project/);
        expect(services.ptyManager.liveShells()).toEqual([]);
        services.settings.set('claude_permission_mode', null);
        await expect(operations.launchClaude(project.id)).rejects.toThrow('Choose a Claude permission mode first');
        const { shellIndex } = await operations.launch(project.id);
        expect(shellIndex).toBe(1);
        expect((await operations.status()).shells).toEqual([
          expect.objectContaining({ projectId: project.id, shellIndex, agent: null, state: 'idle',
            launchName: 'Terminal', pinned: false, startedAt: expect.any(String),
            lastActiveAt: expect.any(String) }),
        ]);
        const identity = services.ptyManager.liveShell(project.id, shellIndex);
        if (!identity) throw new Error('Local PTY identity missing');
        const tracker = new AgentStatusTracker(services.ptyManager, async () => false);
        tracker.spawn({ projectId: project.id, shellIndex, ...identity, agent: 'omp' });
        tracker.ompReport({ projectId: project.id, shellIndex }, identity.generation, 'busy');
        services.agentStatus = tracker;
        expect((await operations.status()).shells).toEqual([
          expect.objectContaining({ projectId: project.id, shellIndex, agent: 'omp', state: 'busy',
            launchName: 'Terminal', pinned: false }),
        ]);
        const listed = await operations.profiles(project.id);
        expect(listed).toEqual({ profiles: expect.any(Array), defaultCliName: null });
        services.settings.set('default_cli_profiles', [
          { name: 'Global', argv: ['/secret/bin/agent'], env: { TOKEN: 'private' }, icon: 'G' },
        ]);
        services.projects.updateConfig(project.id, { cliProfiles: [
          { name: 'Custom', argv: ['local-agent'], env: { TOKEN: 'private' }, icon: 'C' },
        ] });
        expect(await operations.profiles(project.id)).toEqual({
          profiles: [{ name: 'Custom', scope: 'project', icon: 'C' },
            { name: 'Global', scope: 'global', icon: 'G' }],
          defaultCliName: null,
        });
        const cap = services.settings.get('keep_alive_cap');
        services.settings.set('keep_alive_cap', 1);
        services.shells.setPinned(project.id, shellIndex, true);
        await expect(operations.launchCli(project.id, { profileName: 'Custom' }))
          .rejects.toThrow(/all shells are pinned/);
        expect((await operations.status()).shells[0]?.pinned).toBe(true);
        services.shells.setPinned(project.id, shellIndex, false);
        services.settings.set('keep_alive_cap', cap);
        const mockSpawn = vi.spyOn(services.ptyManager, 'spawn').mockResolvedValue({ pid: 123 });
        expect(await operations.launchCli(project.id, { profileName: 'Custom' })).toEqual({ shellIndex: 0 });
        expect(mockSpawn).toHaveBeenCalledWith(project.id, 0,
          expect.objectContaining({ argv: ['local-agent'], cwd: projectPath }));
        expect(await operations.setDefaultCli(project.id, 'Custom')).toEqual({ defaultCliName: 'Custom' });
        expect(await operations.profiles(project.id)).toMatchObject({ defaultCliName: 'Custom' });
        expect(await operations.removeCliProfile(project.id, 'Custom')).toEqual({ ok: true });
        expect((await operations.profiles(project.id)).profiles).toEqual([
          { name: 'Global', scope: 'global', icon: 'G' },
        ]);
        mockSpawn.mockRestore();
        services.agentStatus = null;
        const activeShell = services.ptyManager.liveShells()[0];
        if (!activeShell) throw new Error('Local PTY did not start');
        vi.spyOn(services.ptyManager, 'liveShells').mockReturnValueOnce(
          Array.from({ length: 257 }, (_, index) => ({ ...activeShell, shellIndex: index })),
        );
        expect(() => operations.status()).toThrow(/256-root\/project\/shell limit/);
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
        services.settings.set('claude_permission_mode', 'bypass');
        const spawn = vi.spyOn(services.ptyManager, 'spawn').mockResolvedValue({ pid: 31415 });
        expect(await operations.launchClaude(project.id)).toEqual({ shellIndex: 0 });
        expect(spawn).toHaveBeenCalledWith(project.id, 0, expect.objectContaining({
          argv: expect.arrayContaining([expect.stringContaining('claude')]),
          cwd: projectPath,
        }));
        spawn.mockRestore();
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
          rootId: root.id,
          id: longProject.id,
          name: 'a'.repeat(155),
        });
        const unnamed = services.projects.upsert(root.id, join(home, 'root', 'unnamed'), '\0');
        expect((await operations.status()).projects.find(({ id }) => id === unnamed.id)).toEqual({
          id: unnamed.id,
          rootId: root.id,
          name: 'Unnamed project',
        });
        for (let index = 0; index < 253; index++) {
          services.projects.upsert(root.id, join(home, 'root', `extra-${index}`), `Extra ${index}`);
        }
        expect(() => operations.status()).toThrow(/256-root\/project\/shell limit/);
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
        deletePassword: async (service, account) => credentials.delete(`${service}:${account}`),
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
      const broadcast = vi.fn();
      local.onTerminal((event) => broadcast('fleet:terminal', event));
      registerIpc(
        {
          handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
            channels.set(channel, handler);
          },
        } as unknown as IpcMain,
        a,
        broadcast,
      );
      const remoteChannels = new Map<string, (...args: unknown[]) => unknown>();
      const remoteBroadcast = vi.fn();
      remote.onChanged((state) => remoteBroadcast('fleet:changed', state));
      registerIpc(
        { handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
          remoteChannels.set(channel, handler);
        } } as unknown as IpcMain,
        b,
        remoteBroadcast,
      );
      const invokeRemote = async (channel: string, req: unknown): Promise<unknown> => {
        const handler = remoteChannels.get(channel);
        if (!handler) throw new Error(`Remote IPC channel unavailable: ${channel}`);
        return handler({ sender: {} }, req);
      };
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
        await expect(invoke('fleet:profiles', { peerId: peer.id, projectId: project.id })).rejects.toThrow();
        await expect(invoke('fleet:launch-cli', { peerId: peer.id, projectId: project.id,
          argv: ['echo', 'never'] })).rejects.toThrow();
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
          roots: [{ id: root.id, name: 'root' }],
          projects: [{ id: project.id, rootId: root.id, name: 'Remote project' }],
        });
        expect(await invoke('fleet:git-status', { peerId: peer.id, projectId: project.id })).toEqual({
          isRepo: false, branch: null, dirty: false, ahead: 0, behind: 0, changedCount: 0,
        });
        await expect(invoke('fleet:git-status', { peerId: peer.id, projectId: project.id + 10_000 }))
          .rejects.toThrow('Peer refused fleet operation');
        const launched = await invoke('fleet:launch', { peerId: peer.id, projectId: project.id });
        if (
          !launched ||
          typeof launched !== 'object' ||
          !('shellIndex' in launched) ||
          typeof launched.shellIndex !== 'number'
        )
          throw new Error('Remote shell did not launch');
        const shellIndex = launched.shellIndex;
        const attached = await invoke('fleet:subscribe', { peerId: peer.id, projectId: project.id, shellIndex });
        if (!attached || typeof attached !== 'object' || !('subscriptionId' in attached) ||
          typeof attached.subscriptionId !== 'string') throw new Error('No remote subscription');
        await vi.waitFor(() => expect(broadcast).toHaveBeenCalledWith('fleet:terminal',
          expect.objectContaining({ peerId: peer.id, subscriptionId: attached.subscriptionId, kind: 'ready' })));
        expect(remote.state().controls).toEqual([
          { projectId: project.id, shellIndex, peerName: 'Local IDE' },
        ]);
        expect(remoteBroadcast).toHaveBeenCalledWith('fleet:changed',
          expect.objectContaining({ controls: remote.state().controls }));
        const resize = vi.spyOn(b.ptyManager, 'resize');
        await expect(invokeRemote('shells:resize', {
          projectId: project.id, shellIndex, cols: 71, rows: 22,
        })).resolves.toEqual({ ok: true });
        expect(resize).not.toHaveBeenCalled();
        await invoke('fleet:resize', { peerId: peer.id, projectId: project.id, shellIndex, cols: 91, rows: 35 });
        expect(resize).toHaveBeenCalledWith(project.id, shellIndex, 91, 35);
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
        await vi.waitFor(() => expect(broadcast).toHaveBeenCalledWith('fleet:terminal',
          expect.objectContaining({ peerId: peer.id, subscriptionId: attached.subscriptionId,
            kind: 'data', data: expect.stringContaining('FLEET_IPC_READY') })));
        await invoke('fleet:unsubscribe', { peerId: peer.id, subscriptionId: attached.subscriptionId });
        expect(remote.state().controls).toEqual([]);
        await invokeRemote('shells:resize', { projectId: project.id, shellIndex, cols: 77, rows: 23 });
        expect(resize).toHaveBeenCalledWith(project.id, shellIndex, 77, 23);
        await invoke('fleet:stop', { peerId: peer.id, projectId: project.id, shellIndex });
        expect(
          await invoke('fleet:snapshot', { peerId: peer.id, projectId: project.id, shellIndex }),
        ).toMatchObject({ alive: false });
        b.settings.set('default_cli_profiles', [
          { name: 'Host agent', argv: ['/secret/bin/agent'], env: { ACCESS_TOKEN: 'never-wire' }, icon: 'H' },
        ]);
        b.projects.updateConfig(project.id, { cliProfiles: [
          { name: 'Project agent', argv: ['agent'], env: { TOKEN: 'private' }, icon: 'P' },
        ] });
        expect(await invoke('fleet:profiles', { peerId: peer.id, projectId: project.id })).toEqual({
          profiles: [{ name: 'Project agent', scope: 'project', icon: 'P' },
            { name: 'Host agent', scope: 'global', icon: 'H' }], defaultCliName: null,
        });
        expect(JSON.stringify(await invoke('fleet:profiles', { peerId: peer.id, projectId: project.id })))
          .not.toMatch(/never-wire|private|\/secret\/bin/);
        expect(await invoke('fleet:set-default-cli', { peerId: peer.id, projectId: project.id,
          name: 'Project agent' })).toEqual({ defaultCliName: 'Project agent' });
        const spawn = vi.spyOn(b.ptyManager, 'spawn').mockResolvedValue({ pid: 123 });
        expect(await invoke('fleet:launch-cli', { peerId: peer.id, projectId: project.id,
          profileName: 'Project agent' })).toMatchObject({ shellIndex: expect.any(Number) });
        expect(spawn).toHaveBeenCalledWith(project.id, expect.any(Number),
          expect.objectContaining({ argv: ['agent'], env: expect.objectContaining({ TOKEN: 'private' }) }));
        await invoke('fleet:launch-cli', { peerId: peer.id, projectId: project.id,
          profileName: 'Saved agent', argv: ['agent', '--quiet'], save: true });
        expect(await invoke('fleet:profiles', { peerId: peer.id, projectId: project.id }))
          .toMatchObject({ profiles: expect.arrayContaining([{ name: 'Saved agent', scope: 'project' }]) });
        expect(await invoke('fleet:remove-cli-profile', { peerId: peer.id, projectId: project.id,
          name: 'Saved agent' })).toEqual({ ok: true });
        expect(await invoke('fleet:set-default-cli', { peerId: peer.id, projectId: project.id,
          name: null })).toEqual({ defaultCliName: null });
        spawn.mockRestore();
        await invoke('fleet:revoke', { peerId: peer.id });
        await expect(invoke('fleet:status', { peerId: peer.id })).rejects.toThrow();
        await expect(invoke('fleet:profiles', { peerId: peer.id, projectId: project.id })).rejects.toThrow();
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

describe('Fleet port and recovery IPC', () => {
  function fixture() {
    const home = mkdtempSync(join(tmpdir(), 'fleet-port-ipc-'));
    roots.push(home);
    const services = buildServices({
      homeDir: home,
      dbPath: join(home, 'state.db'),
      migrationsDir: resolve('migrations'),
    });
    const credentials = new Map<string, string>();
    const keychain: FleetKeychain = {
      getPassword: async (service, account) => credentials.get(`${service}:${account}`) ?? null,
      setPassword: async (service, account, password) => {
        credentials.set(`${service}:${account}`, password);
      },
      deletePassword: async (service, account) => credentials.delete(`${service}:${account}`),
    };
    services.fleet = new FleetService({
      name: 'Local IDE',
      storageDir: join(home, 'fleet'),
      operations: createFleetOperations(services),
      keychain,
      getPort: () => services.settings.get('fleet_port'),
      savePort: (port) => services.settings.set('fleet_port', port),
    });
    const channels = new Map<string, (...args: unknown[]) => unknown>();
    registerIpc(
      {
        handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
          channels.set(channel, handler);
        },
      } as unknown as IpcMain,
      services,
      vi.fn(),
    );
    const invoke = async (channel: string, req?: unknown): Promise<unknown> => {
      const handler = channels.get(channel);
      if (!handler) throw new Error(`IPC channel unavailable: ${channel}`);
      return handler({ sender: {} }, req);
    };
    return { services, invoke, credentials };
  }

  it('defaults the persisted port to 43872 and rejects every malformed fleet:set-port payload', async () => {
    const { services, invoke } = fixture();
    try {
      await services.fleet?.start();
      expect(services.settings.get('fleet_port')).toBe(43872);
      const payloads: unknown[] = [
        undefined,
        null,
        'x',
        42,
        [],
        {},
        { port: null },
        { port: '43872' },
        { port: 43872.5 },
        { port: Number.NaN },
        { port: 80 },
        { port: 1023 },
        { port: 65536 },
        { port: -1 },
      ];
      for (const payload of payloads)
        await expect(invoke('fleet:set-port', payload), JSON.stringify(payload)).rejects.toThrow(
          'Fleet port must be an integer between 1024 and 65535',
        );
      expect(services.settings.get('fleet_port')).toBe(43872);
      await expect(invoke('fleet:set-port', { port: 45123 })).resolves.toMatchObject({
        port: 45123,
        enabled: false,
      });
      expect(services.settings.get('fleet_port')).toBe(45123);
    } finally {
      await services.fleet?.stop();
      services.db.close();
    }
  });

  it('records a validated fleet:viewing and rejects every cast payload without changing it', async () => {
    const { services, invoke } = fixture();
    try {
      const shell = { peerId: 'a'.repeat(64), projectId: 7, shellIndex: 0 };
      await expect(invoke('fleet:viewing', { shell })).resolves.toEqual({ ok: true });
      expect(services.fleet?.viewing()).toEqual(shell);
      for (const payload of [undefined, null, {}, { shell: { ...shell, peerId: 'x' } },
        { shell: { ...shell, projectId: '7' } }, { shell: { ...shell, shellIndex: -1 } }, { shell, extra: 1 }])
        await expect(invoke('fleet:viewing', payload), JSON.stringify(payload)).rejects.toThrow(/invalid fleet:viewing/);
      expect(services.fleet?.viewing()).toEqual(shell);
      await invoke('fleet:viewing', { shell: null });
      expect(services.fleet?.viewing()).toBeNull();
    } finally {
      services.db.close();
    }
  });

  it('rejects fleet:git-status for a cast project ID or an unlinked peer', async () => {
    const { services, invoke } = fixture();
    try {
      await services.fleet?.start();
      for (const projectId of [0, -1, 1.5, '7'])
        await expect(invoke('fleet:git-status', { peerId: 'a'.repeat(64), projectId })).rejects.toThrow('Invalid project ID');
      await expect(invoke('fleet:git-status', { peerId: 'a'.repeat(64), projectId: 1 })).rejects.toThrow('Peer is not linked and online');
      await expect(invoke('fleet:git-status', null)).rejects.toThrow();
    } finally {
      await services.fleet?.stop();
      services.db.close();
    }
  });

  it('refuses fleet:reset-identity while the identity is healthy and keeps the credential', async () => {
    const { services, invoke, credentials } = fixture();
    try {
      await services.fleet?.start();
      await expect(invoke('fleet:reset-identity')).rejects.toThrow(
        'Fleet identity reset is not available',
      );
      expect(credentials.size).toBe(0);
    } finally {
      await services.fleet?.stop();
      services.db.close();
    }
  });
});

describe('Fleet git summary', () => {
  const repo = { isRepo: true, branch: 'main', ahead: 1, behind: 2, dirty: true,
    files: { 'src/secret.ts': 'M', '/private/key': '?' } } as const;

  it('keeps only the branch, counts and dirty flag, never the paths', () => {
    const summary = fleetGitSummary(repo);
    expect(summary).toEqual({ isRepo: true, branch: 'main', dirty: true, ahead: 1, behind: 2, changedCount: 2 });
    expect(JSON.stringify(summary)).not.toContain('secret');
  });

  it('carries no data for a non-repository', () => {
    expect(fleetGitSummary({ ...repo, isRepo: false })).toEqual({
      isRepo: false, branch: null, dirty: false, ahead: 0, behind: 0, changedCount: 0,
    });
  });

  it('cuts a long branch to 255 bytes on a character boundary and caps counts', () => {
    const summary = fleetGitSummary({ ...repo, branch: 'é'.repeat(200), ahead: 5_000_000, behind: -3 });
    expect(Buffer.byteLength(summary.branch ?? '', 'utf8')).toBe(254);
    expect(summary.branch).toBe('é'.repeat(127));
    expect(summary.ahead).toBe(1_000_000);
    expect(summary.behind).toBe(0);
    expect(fleetGitSummary({ ...repo, branch: 'b'.repeat(300) }).branch).toBe('b'.repeat(255));
  });

  it('drops a branch containing control characters and an empty branch', () => {
    expect(fleetGitSummary({ ...repo, branch: 'main\x1b[2J' }).branch).toBeNull();
    expect(fleetGitSummary({ ...repo, branch: '' }).branch).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('serves only visible projects through the real git status handler', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fleet-git-'));
    roots.push(home);
    const projectPath = join(home, 'root', 'repo');
    mkdirSync(projectPath, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'feature/x'], { cwd: projectPath });
    writeFileSync(join(projectPath, 'secret-name.txt'), 'x');
    const services = buildServices({ homeDir: home, dbPath: join(home, 'state.db'), migrationsDir: resolve('migrations') });
    try {
      const root = services.roots.add(join(home, 'root'));
      const project = services.projects.upsert(root.id, projectPath, 'Repo');
      const operations = createFleetOperations(services);
      const summary = await operations.gitStatus(project.id);
      expect(summary).toMatchObject({ isRepo: true, dirty: true, changedCount: 1 });
      expect(JSON.stringify(summary)).not.toContain('secret-name');
      await expect(operations.gitStatus(project.id + 10_000)).rejects.toThrow(/no project/);
      services.projects.setHidden(project.id, true);
      await expect(operations.gitStatus(project.id)).rejects.toThrow(/no project/);
    } finally {
      services.db.close();
    }
  });
});
