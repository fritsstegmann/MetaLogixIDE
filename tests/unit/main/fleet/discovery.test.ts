import { describe, expect, it } from 'vitest';
import { FleetDiscovery } from '@main/fleet/discovery';

const local = 'a'.repeat(64);
const remote = 'b'.repeat(64);
const beacon = Buffer.from(JSON.stringify({ v: 1, id: remote, name: 'Remote', port: 41111 }));

describe('fleet public discovery', () => {
  it('tracks only public identity, ignores its own ID and expires stale peers', () => {
    const states: number[] = [];
    const discovery = new FleetDiscovery(local, 'Local', (peers) => {
      states.push(peers.length);
    });
    discovery.observe(
      Buffer.from(JSON.stringify({ v: 1, id: local, name: 'self', port: 1 })),
      '127.0.0.1',
    );
    expect(discovery.list()).toEqual([]);
    discovery.observe(beacon, '192.168.1.20');
    expect(discovery.list()).toMatchObject([
      { id: remote, name: 'Remote', host: '192.168.1.20', port: 41111 },
    ]);
    discovery.expire(Date.now() + 16_000);
    expect(discovery.list()).toEqual([]);
    expect(states).toEqual([1, 0]);
  });
  it('expires at the boundary, refreshes on repeat beacon and emits changes only on identity updates', () => {
    const states: number[] = [];
    const discovery = new FleetDiscovery(local, 'Local', (peers) => {
      states.push(peers.length);
    });
    discovery.observe(beacon, '192.168.1.20');
    const seen = discovery.list()[0]?.seen;
    if (seen === undefined) throw new Error('Missing discovery observation');
    discovery.expire(seen + 14_999);
    expect(discovery.list()).toHaveLength(1);
    discovery.observe(beacon, '192.168.1.20');
    expect(states).toEqual([1]);
    const refreshed = discovery.list()[0]?.seen;
    if (refreshed === undefined) throw new Error('Missing refreshed observation');
    discovery.expire(refreshed + 15_000);
    expect(discovery.list()).toEqual([]);
    expect(states).toEqual([1, 0]);
  });

  it('rejects malformed and secret-bearing discovery packets', () => {
    const discovery = new FleetDiscovery(local, 'Local', () => {});
    discovery.observe(Buffer.from('{bad'), '192.168.1.20');
    discovery.observe(
      Buffer.from(
        JSON.stringify({ v: 1, id: remote, name: 'Remote', port: 41111, password: 'secret' }),
      ),
      '192.168.1.20',
    );
    expect(discovery.list()).toEqual([]);
  });
  it('limits multicast advertisements from one source per second', () => {
    const discovery = new FleetDiscovery(local, 'Local', () => {});
    for (let i = 0; i < 40; i++) {
      const id = i.toString(16).padStart(64, '0');
      discovery.observe(
        Buffer.from(JSON.stringify({ v: 1, id, name: 'Remote', port: 41111 })),
        '192.168.1.20',
      );
    }
    expect(discovery.list()).toHaveLength(20);
  });
});
