import { afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Server as TlsServer } from 'node:tls';
import { join } from 'node:path';
import { FleetService, type FleetOperations } from '@main/fleet/service';
import { FleetDiscovery } from '@main/fleet/discovery';

const roots: string[] = [];
const secrets = new Map<string, string>();
const keychain = {
  async getPassword(service: string, account: string) {
    return secrets.get(`${service}:${account}`) ?? null;
  },
  async setPassword(service: string, account: string, password: string) {
    secrets.set(`${service}:${account}`, password);
  },
};
const instances: FleetService[] = [];
afterAll(async () => {
  for (const instance of instances) await instance.stop();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function announceTo(receiver: FleetService, remote: FleetService, name: string) {
  const discovery: unknown = Reflect.get(receiver, 'discovery');
  const identity: unknown = Reflect.get(remote, 'identity');
  const server: unknown = Reflect.get(remote, 'server');
  if (
    !(discovery instanceof FleetDiscovery) ||
    !(server instanceof TlsServer) ||
    identity === null ||
    typeof identity !== 'object' ||
    !('id' in identity) ||
    typeof identity.id !== 'string'
  )
    throw new Error('Live fleet runtime unavailable');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Live fleet listener unavailable');
  discovery.observe(
    Buffer.from(JSON.stringify({ v: 1, id: identity.id, name, port: address.port })),
    '127.0.0.1',
  );
}

it('links two distinct IDE runtimes over real TLS after local discovery; controls and revokes a remote shell', async () => {
  const writes: string[] = [];
  const stopped: string[] = [];
  const localOps: FleetOperations = {
    status: () => ({ projects: [], shells: [] }),
    launch: async () => ({ shellIndex: 0 }),
    stop: async () => {},
    write: async () => {},
    snapshot: async () => ({ output: '', alive: false }),
  };
  const remoteOps: FleetOperations = {
    status: () => ({
      projects: [{ id: 1, name: 'Remote project' }],
      shells: [{ projectId: 1, shellIndex: 0, agent: 'omp', state: 'busy' }],
    }),
    launch: async (id) => {
      expect(id).toBe(1);
      return { shellIndex: 0 };
    },
    stop: async (id, index) => {
      stopped.push(`${id}:${index}`);
    },
    write: async (_id, _index, text) => {
      writes.push(text);
    },
    snapshot: async () => ({ output: '<terminal text>', alive: true }),
  };
  function instance(name: string, operations: FleetOperations) {
    const root = mkdtempSync(join(tmpdir(), 'metaide-fleet-smoke-'));
    roots.push(root);
    const service = new FleetService({
      name,
      storageDir: join(root, 'fleet'),
      operations,
      keychain,
    });
    instances.push(service);
    return service;
  }
  const a = instance('Fleet A', localOps);
  const b = instance('Fleet B', remoteOps);
  await a.start();
  await b.start();
  await a.setEnabled(true);
  await b.setEnabled(true);
  // This host's multicast loopback does not deliver even to two raw UDP sockets.
  // Inject only the public discovery beacon; pairing and every command use real TLS.
  announceTo(a, b, 'Fleet B');
  announceTo(b, a, 'Fleet A');
  const idB = a.state().peers.find((peer) => peer.name === 'Fleet B')?.id;
  const idA = b.state().peers.find((peer) => peer.name === 'Fleet A')?.id;
  if (!idA || !idB) throw new Error('Both runtimes must discover one another');
  await expect(a.status(idB)).rejects.toThrow();
  await a.pair(idB);
  await vi.waitFor(
    () => {
      expect(a.state().peers.find((peer) => peer.id === idB)?.status).toBe('pending');
      expect(b.state().peers.find((peer) => peer.id === idA)?.status).toBe('pending');
    },
    { timeout: 10_000, interval: 100 },
  );
  const codeA = a.state().peers.find((peer) => peer.id === idB)?.verificationCode;
  const codeB = b.state().peers.find((peer) => peer.id === idA)?.verificationCode;
  expect(codeA).toBeTruthy();
  expect(codeA).toBe(codeB);
  if (!codeA || !codeB) throw new Error('Comparison codes missing');
  await a.approve(idB, codeA);
  await b.approve(idA, codeB);
  await vi.waitFor(
    () => {
      expect(a.state().peers.find((peer) => peer.id === idB)?.status).toBe('linked');
      expect(b.state().peers.find((peer) => peer.id === idA)?.status).toBe('linked');
    },
    { timeout: 10_000, interval: 100 },
  );
  expect(await a.status(idB)).toEqual({
    projects: [{ id: 1, name: 'Remote project' }],
    shells: [{ projectId: 1, shellIndex: 0, agent: 'omp', state: 'busy' }],
  });
  expect(await a.launch(idB, 1)).toEqual({ shellIndex: 0 });
  expect(await a.snapshot(idB, 1, 0)).toEqual({ output: '<terminal text>', alive: true });
  await a.write(idB, 1, 0, 'echo smoke\r');
  await a.stopShell(idB, 1, 0);
  expect(writes).toEqual(['echo smoke\r']);
  expect(stopped).toEqual(['1:0']);
  await a.revoke(idB);
  await expect(a.status(idB)).rejects.toThrow();
  await vi.waitFor(
    () => {
      expect(b.state().peers.find((peer) => peer.id === idA)?.status).toBe('offline');
    },
    { timeout: 10_000, interval: 100 },
  );
}, 30_000);
