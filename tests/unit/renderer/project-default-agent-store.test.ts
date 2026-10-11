/** Contract tests for immutable settings sessions, explicit persistence, failures, and late-result isolation. */
import { describe, expect, it, vi } from 'vitest';
import type { Project, ProjectConfig } from '@shared/types';
import type { ScopedCliProfile } from '@shared/project-default-agent';
import { createProjectDefaultAgentStore, type ProjectDefaultAgentPorts } from '@renderer/project-default-agent-store';

function project(id = 1, config: ProjectConfig = {}): Project {
  return { id, rootId: 1, name: `Project ${id}`, path: `/projects/${id}`, config,
    metaprojectProjectId: null, linkedChatChannelId: null, lastOpenedAt: null,
    pinned: false, hidden: false, firstLaunchedAt: null };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const profiles: ScopedCliProfile[] = [
  { name: 'Codex', argv: ['codex'], scope: 'project' },
  { name: 'inherit:', argv: ['custom'], scope: 'global' },
];

function harness(initial = project()) {
  let persisted = initial;
  const loadProject = vi.fn(async () => persisted);
  const loadProfiles = vi.fn(async () => profiles);
  const save = vi.fn<ProjectDefaultAgentPorts['save']>(async ({ projectId, name }) => {
    persisted = { ...persisted, id: projectId, config: { ...persisted.config, defaultCliName: name, launchCmd: null } };
    return persisted;
  });
  const onSaved = vi.fn();
  const ports: ProjectDefaultAgentPorts = { loadProject, loadProfiles, save, onSaved };
  return { ports, loadProject, loadProfiles, save, onSaved, persisted: () => persisted };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

async function ready(h = harness()) {
  const store = createProjectDefaultAgentStore(project(), h.ports);
  store.connect();
  await settle();
  return store;
}

describe('project default settings session', () => {
  it('loads each port concurrently once and never writes on open or close', async () => {
    const h = harness();
    const config = deferred<Project>();
    const catalog = deferred<ScopedCliProfile[]>();
    h.loadProject.mockReturnValue(config.promise);
    h.loadProfiles.mockReturnValue(catalog.promise);
    const store = createProjectDefaultAgentStore(project(), h.ports);
    const disconnect = store.connect();
    store.connect();
    expect(h.loadProject.mock.calls).toEqual([[1]]);
    expect(h.loadProfiles.mock.calls).toEqual([[1]]);
    store.choose('Codex');
    config.resolve(project());
    await settle();
    expect(store.getSnapshot().status).toBe('loading');
    expect(h.save).not.toHaveBeenCalled();
    catalog.resolve([]);
    await settle();
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', profiles: [], confirmedName: null });
    disconnect();
    expect(h.save).not.toHaveBeenCalled();
  });

  it.each(['configuration', 'catalog'])('distinguishes failed %s from empty success and retries explicitly', async (failed) => {
    const h = harness();
    if (failed === 'configuration') h.loadProject.mockRejectedValueOnce(new Error('Read denied'));
    else h.loadProfiles.mockRejectedValueOnce(new Error('Read denied'));
    const store = await ready(h);
    expect(store.getSnapshot()).toMatchObject({ status: 'error', message: 'Read denied' });
    store.choose(null);
    expect(h.save).not.toHaveBeenCalled();
    store.retry();
    await settle();
    expect(store.getSnapshot().status).toBe('ready');
    expect(h.loadProject).toHaveBeenCalledTimes(2);
    expect(h.loadProfiles).toHaveBeenCalledTimes(2);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('keeps immutable confirmed data while pending and blocks overlapping saves', async () => {
    const h = harness(project(1, { notes: 'Keep', defaultCliName: 'inherit:' }));
    const saved = deferred<Project>();
    h.save.mockReturnValue(saved.promise);
    const store = await ready(h);
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);
    store.choose('Codex');
    expect(store.getSnapshot()).toMatchObject({ confirmedName: 'inherit:', pendingName: 'Codex', feedback: { status: 'saving' } });
    expect(before).toMatchObject({ confirmedName: 'inherit:', feedback: { status: 'idle' } });
    store.choose(null);
    store.replaceCustomCommands();
    expect(h.save.mock.calls).toEqual([[{ projectId: 1, name: 'Codex' }]]);
    const returned = project(1, { notes: 'Keep', defaultCliName: 'Codex', launchCmd: null });
    saved.resolve(returned);
    await settle();
    expect(store.getSnapshot()).toMatchObject({ project: returned, confirmedName: 'Codex', pendingName: 'Codex', feedback: { status: 'saved' } });
    expect(h.onSaved.mock.calls).toEqual([[returned]]);
  });

  it('restores last confirmed choice on failed save and permits explicit recovery', async () => {
    const h = harness(project(1, { defaultCliName: 'Codex' }));
    h.save.mockRejectedValueOnce(new Error('Write denied'));
    const store = await ready(h);
    store.choose(null);
    await settle();
    expect(store.getSnapshot()).toMatchObject({ confirmedName: 'Codex', pendingName: 'Codex', feedback: { status: 'error', message: 'Write denied' } });
    expect(h.onSaved).not.toHaveBeenCalled();
    expect(h.persisted().config.defaultCliName).toBe('Codex');
    store.choose(null);
    await settle();
    expect(h.persisted().config.defaultCliName).toBeNull();
    expect(store.getSnapshot()).toMatchObject({ confirmedName: null, feedback: { status: 'saved' } });
  });

  it.each([null, 'Codex'])('only explicit legacy replacement saves an unchanged %s choice', async (name) => {
    const h = harness(project(1, { defaultCliName: name, launchCmd: { subsequent: { argv: ['legacy'], env: {} } } }));
    const store = await ready(h);
    store.choose(name);
    expect(h.save).not.toHaveBeenCalled();
    store.replaceCustomCommands();
    await settle();
    expect(h.save.mock.calls).toEqual([[{ projectId: 1, name }]]);
    expect(h.persisted().config.launchCmd).toBeNull();
    store.replaceCustomCommands();
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it('retains exact missing saved name without writes and rejects invalid selections', async () => {
    const h = harness(project(1, { defaultCliName: ' Removed ' }));
    const store = await ready(h);
    expect(store.getSnapshot()).toMatchObject({ confirmedName: ' Removed ', pendingName: ' Removed ' });
    store.replaceCustomCommands();
    store.choose('not-in-catalog');
    expect(h.save).not.toHaveBeenCalled();
    store.choose('inherit:');
    await settle();
    expect(h.save.mock.calls).toEqual([[{ projectId: 1, name: 'inherit:' }]]);
  });

  it('ignores disposed loads and reloads persisted state on reconnect', async () => {
    const h = harness();
    const delayed = deferred<Project>();
    h.loadProject.mockReturnValueOnce(delayed.promise);
    const store = createProjectDefaultAgentStore(project(), h.ports);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const disconnect = store.connect();
    disconnect();
    store.connect();
    await settle();
    const current = store.getSnapshot();
    delayed.resolve(project(1, { defaultCliName: 'stale' }));
    await settle();
    expect(store.getSnapshot()).toBe(current);
    unsubscribe();
    listener.mockClear();
    store.choose('Codex');
    await settle();
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps a disposed A save attached to A and never publishes into B or callback', async () => {
    const a = harness();
    const delayed = deferred<Project>();
    a.save.mockReturnValue(delayed.promise);
    const storeA = createProjectDefaultAgentStore(project(), a.ports);
    const close = storeA.connect();
    await settle();
    storeA.choose('Codex');
    const pending = storeA.getSnapshot();
    close();
    const b = harness(project(2, { defaultCliName: 'inherit:' }));
    const storeB = createProjectDefaultAgentStore(project(2), b.ports);
    storeB.connect();
    await settle();
    const bBefore = storeB.getSnapshot();
    delayed.resolve(project(1, { defaultCliName: 'Codex' }));
    await settle();
    expect(a.save.mock.calls).toEqual([[{ projectId: 1, name: 'Codex' }]]);
    expect(storeA.getSnapshot()).toBe(pending);
    expect(storeB.getSnapshot()).toBe(bBefore);
    expect(a.onSaved).not.toHaveBeenCalled();
    expect(b.save).not.toHaveBeenCalled();
  });

  it('ignores a late failed save and guards wrong-project load/save results', async () => {
    const h = harness();
    h.loadProject.mockResolvedValueOnce(project(2));
    const store = await ready(h);
    expect(store.getSnapshot().status).toBe('error');
    store.retry();
    await settle();
    h.save.mockResolvedValueOnce(project(2));
    store.choose('Codex');
    await settle();
    expect(store.getSnapshot()).toMatchObject({ confirmedName: null, feedback: { status: 'error' } });
    const delayed = deferred<Project>();
    h.save.mockReturnValueOnce(delayed.promise);
    store.choose('Codex');
    const pending = store.getSnapshot();
    const close = store.connect();
    close();
    delayed.reject('failure');
    await settle();
    expect(store.getSnapshot()).toBe(pending);
    expect(h.onSaved).not.toHaveBeenCalled();
  });

  it('reopening reads actual saved choice and reset without extra writes', async () => {
    const h = harness(project(1, { notes: 'Preserve', env: { KEEP: 'value' } }));
    const first = await ready(h);
    first.choose('Codex');
    await settle();
    first.connect()();
    const reopened = await ready(h);
    expect(reopened.getSnapshot()).toMatchObject({ confirmedName: 'Codex', project: { config: { notes: 'Preserve', env: { KEEP: 'value' } } } });
    expect(h.save).toHaveBeenCalledTimes(1);
    reopened.choose(null);
    await settle();
    reopened.connect()();
    const reset = await ready(h);
    expect(reset.getSnapshot()).toMatchObject({ confirmedName: null, pendingName: null });
    expect(h.save.mock.calls).toEqual([[{ projectId: 1, name: 'Codex' }], [{ projectId: 1, name: null }]]);
  });

  it('captures opener identity rather than following a mutated caller object', async () => {
    const h = harness();
    const opener = project();
    const store = createProjectDefaultAgentStore(opener, h.ports);
    opener.id = 2;
    store.connect();
    await settle();
    store.choose('Codex');
    await settle();
    expect(h.loadProject.mock.calls).toEqual([[1]]);
    expect(h.save.mock.calls).toEqual([[{ projectId: 1, name: 'Codex' }]]);
    expect(store.getSnapshot()).toMatchObject({ target: { id: 1 }, project: { id: 1 } });
  });

  it('exposes safe recovery for non-Error failures without turning them into empty success', async () => {
    const h = harness();
    h.loadProfiles.mockRejectedValueOnce({ secret: 'not displayable' });
    const store = await ready(h);
    expect(store.getSnapshot()).toMatchObject({ status: 'error', message: 'Please try again.' });
    store.retry();
    await settle();
    h.save.mockRejectedValueOnce('private failure');
    store.choose('Codex');
    await settle();
    expect(store.getSnapshot()).toMatchObject({ confirmedName: null, pendingName: null, feedback: { status: 'error', message: 'Please try again.' } });
    expect(h.onSaved).not.toHaveBeenCalled();
  });
});
