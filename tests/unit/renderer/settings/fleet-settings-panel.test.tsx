/** Fleet settings tests cover explicit opt-in, live events, network errors and no pairing controls. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import type * as ReactModule from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FleetState } from '@shared/fleet-contract';
import type { EnvDrafts } from '@renderer/hooks/useEnvDrafts';

const runtime = vi.hoisted(() => {
  const slots: unknown[] = [];
  const effects: Array<{ deps?: readonly unknown[]; cleanup?: () => void; run?: () => unknown }> =
    [];
  let cursor = 0;
  let effectCursor = 0;
  return {
    reset() {
      slots.length = 0;
      effects.length = 0;
    },
    render<T>(render: () => T): T {
      cursor = 0;
      effectCursor = 0;
      const result = render();
      for (const effect of effects) {
        if (!effect.run) continue;
        effect.cleanup?.();
        const cleanup = effect.run();
        effect.run = undefined;
        effect.cleanup =
          typeof cleanup === 'function'
            ? () => {
                cleanup();
              }
            : undefined;
      }
      return result;
    },
    unmount() {
      for (const effect of effects) effect.cleanup?.();
    },
    useState<S>(initial: S) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      const set = (next: S | ((previous: S) => S)) => {
        slots[index] =
          typeof next === 'function' ? (next as (previous: S) => S)(slots[index] as S) : next;
      };
      return [slots[index] as S, set] as const;
    },
    useRef<S>(initial: S) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index] as { current: S };
    },
    useEffect(run: () => unknown, deps?: readonly unknown[]) {
      const index = effectCursor++;
      if (effects[index]) return;
      effects[index] = { run, deps };
    },
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof ReactModule>()),
  useState: runtime.useState,
  useRef: runtime.useRef,
  useEffect: runtime.useEffect,
}));

const invoke = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Set<(state: FleetState) => void>());
vi.mock('@renderer/api', () => ({
  api: {
    invoke,
    on: vi.fn((_channel: string, listener: (state: FleetState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  },
}));
vi.mock('@renderer/components/settings/GeneralPanel', () => ({
  GeneralPanel: () => <p>General appearance</p>,
}));
const { FleetSettingsPanel } = await import('@renderer/components/settings/FleetSettingsPanel');
const { SettingsSectionPanel } = await import('@renderer/components/settings/SettingsSectionPanel');
const { Switch } = await import('@renderer/components/settings/primitives');
const off: FleetState = { enabled: false, peers: [] };
const on: FleetState = { enabled: true, peers: [] };
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function findSwitch(node: unknown): ReactElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findSwitch(child);
      if (match) return match;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  if (node.type === Switch) return node;
  const props: unknown = node.props;
  return props && typeof props === 'object' && 'children' in props
    ? findSwitch(props.children)
    : undefined;
}

function mount() {
  const draw = () => runtime.render(() => FleetSettingsPanel());
  draw();
  return {
    draw,
    markup: () => renderToStaticMarkup(draw()),
    change(enabled: boolean) {
      const item = findSwitch(draw());
      if (!item) throw new Error('Missing Fleet switch');
      const props: unknown = item.props;
      if (
        !props ||
        typeof props !== 'object' ||
        !('onChange' in props) ||
        typeof props.onChange !== 'function'
      )
        throw new Error('Fleet switch cannot be changed');
      props.onChange(enabled);
    },
    emit(next: FleetState) {
      for (const listener of listeners) listener(next);
    },
  };
}

beforeEach(() => {
  runtime.reset();
  listeners.clear();
  invoke.mockReset();
  invoke.mockImplementation((channel: string) =>
    Promise.resolve(channel === 'fleet:set-enabled' ? on : off),
  );
});
afterEach(() => {
  runtime.unmount();
});

function renderSection(section: 'fleet' | 'general'): string {
  return runtime.render(() =>
    renderToStaticMarkup(
      <SettingsSectionPanel
        section={section}
        envDrafts={{} as EnvDrafts}
        fontDiscovery={{ status: 'idle' }}
        onLoadInstalledFonts={async () => {}}
      />,
    ),
  );
}

describe('FleetSettingsPanel', () => {
  it('routes the Fleet section to its discovery switch without exposing it in General', async () => {
    renderSection('fleet');
    await flush();
    expect(renderSection('fleet')).toContain('aria-label="Enable Fleet discovery"');
    expect(renderSection('general')).not.toContain('aria-label="Enable Fleet discovery"');
  });

  it('leaves discovery off until the named switch is changed and reflects the saved state', async () => {
    const app = mount();
    await flush();
    expect(app.markup()).toContain('role="switch"');
    expect(app.markup()).toContain('aria-label="Enable Fleet discovery"');
    expect(app.markup()).not.toContain('checked=""');
    expect(invoke).not.toHaveBeenCalledWith('fleet:set-enabled', expect.anything());
    app.change(true);
    expect(invoke).toHaveBeenCalledWith('fleet:set-enabled', { enabled: true });
    await flush();
    expect(app.markup()).toContain('checked=""');
    expect(app.markup()).not.toContain('Approve link');
  });

  it('reflects a remote discovery event and exposes listener failures', async () => {
    const app = mount();
    app.emit({ ...on, error: 'Fleet network unavailable. Check the firewall.' });
    await flush();
    expect(app.markup()).toContain('checked=""');
    expect(app.markup()).toContain('Fleet network unavailable');
    expect(invoke).not.toHaveBeenCalledWith('fleet:set-enabled', expect.anything());
  });

  it('ignores a delayed initial off reply after Fleet announces an enabled state', async () => {
    let finish: ((value: FleetState) => void) | undefined;
    invoke.mockImplementation((channel: string) =>
      channel === 'fleet:get-state'
        ? new Promise<FleetState>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(off),
    );
    const app = mount();
    app.emit(on);
    finish?.(off);
    await flush();
    expect(app.markup()).toContain('checked=""');
  });

  it('keeps a newer Fleet event authoritative over a delayed enable reply', async () => {
    let finish: ((value: FleetState) => void) | undefined;
    invoke.mockImplementation((channel: string) =>
      channel === 'fleet:set-enabled'
        ? new Promise<FleetState>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(off),
    );
    const app = mount();
    await flush();
    app.change(true);
    app.emit(off);
    finish?.(on);
    await flush();
    expect(app.markup()).not.toContain('checked=""');
  });

  it('keeps previous opt-in value and reports a safe actionable error if enabling fails', async () => {
    invoke.mockImplementation((channel: string) =>
      channel === 'fleet:set-enabled'
        ? Promise.reject(new Error('private interface diagnostics'))
        : Promise.resolve(off),
    );
    const app = mount();
    await flush();
    app.change(true);
    await flush();
    expect(app.markup()).not.toContain('checked=""');
    expect(app.markup()).toContain('Could not change Fleet setting');
    expect(app.markup()).not.toContain('private interface diagnostics');
    app.change(true);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'fleet:set-enabled')).toHaveLength(
      2,
    );
  });

  it('reports a failed initial settings load instead of treating failure as off', async () => {
    invoke.mockRejectedValue(new Error('private network diagnostics'));
    const app = mount();
    await flush();
    expect(app.markup()).toContain('Could not load Fleet settings');
    expect(app.markup()).not.toContain('role="switch"');
    expect(app.markup()).not.toContain('private network diagnostics');
  });
});
