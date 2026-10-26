/** Fleet settings tests cover the port form, its default, live events, safe errors and no discovery or pairing controls. */
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
const off: FleetState = { enabled: false, peers: [], port: 43872, controls: [] };
const on: FleetState = { enabled: true, peers: [], port: 43872, controls: [] };
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function find(node: unknown, match: (element: ReactElement) => boolean): ReactElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, match);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  if (match(node)) return node;
  const props: unknown = node.props;
  return props && typeof props === 'object' && 'children' in props
    ? find(props.children, match)
    : undefined;
}

function label(element: ReactElement): string {
  const children = (element.props as { children?: unknown }).children;
  return typeof children === 'string' ? children : '';
}

function mount() {
  const draw = () => runtime.render(() => FleetSettingsPanel());
  draw();
  return {
    draw,
    markup: () => renderToStaticMarkup(draw()),
    field() {
      const node = find(draw(), (item) => item.type === 'input' && (item.props as { 'aria-label'?: string })['aria-label'] === 'Fleet port');
      if (!node) throw new Error('Missing port input');
      return node.props as { value: string; placeholder: string; onChange: (event: { target: { value: string } }) => void };
    },
    button(text: string) {
      const node = find(draw(), (item) => item.type === 'button' && label(item) === text);
      if (!node) throw new Error(`Missing button ${text}`);
      return node.props as { disabled?: boolean; onClick: () => void };
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
  invoke.mockImplementation((channel: string, request?: { port: number }) =>
    Promise.resolve(channel === 'fleet:set-port' ? { ...off, port: request?.port } : off),
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
  it('routes the Fleet section to its port field without exposing it in General', async () => {
    renderSection('fleet');
    await flush();
    expect(renderSection('fleet')).toContain('aria-label="Fleet port"');
    expect(renderSection('general')).not.toContain('aria-label="Fleet port"');
  });

  it('leaves the discovery switch and pairing controls to the Fleet sheet', async () => {
    const app = mount();
    await flush();
    expect(app.markup()).not.toContain('role="switch"');
    expect(app.markup()).not.toContain('Approve link');
    expect(invoke).not.toHaveBeenCalledWith('fleet:set-enabled', expect.anything());
  });

  it('shows the current port, the default port and firewall rules for the current port', async () => {
    invoke.mockResolvedValue({ ...off, port: 45123 });
    const app = mount();
    await flush();
    expect(app.field().value).toBe('45123');
    expect(app.field().placeholder).toBe('43872');
    expect(app.markup()).toContain('Default: 43872');
    expect(app.markup()).toContain('sudo ufw allow 45123/tcp');
    expect(app.markup()).toContain('sudo ufw allow 43871/udp');
  });

  it('saves the typed port through fleet:set-port and shows the returned port', async () => {
    const app = mount();
    await flush();
    app.field().onChange({ target: { value: '45000' } });
    app.button('Save port').onClick();
    await flush();
    expect(invoke).toHaveBeenCalledWith('fleet:set-port', { port: 45000 });
    expect(app.field().value).toBe('45000');
    expect(app.markup()).toContain('sudo ufw allow 45000/tcp');
  });

  it('disables Save while the field is empty or unchanged', async () => {
    const app = mount();
    await flush();
    expect(app.button('Save port').disabled).toBe(true);
    app.field().onChange({ target: { value: '' } });
    expect(app.button('Save port').disabled).toBe(true);
    app.field().onChange({ target: { value: '43873' } });
    expect(app.button('Save port').disabled).toBe(false);
  });

  it('offers Use default only when the port differs from the default', async () => {
    const app = mount();
    await flush();
    expect(app.button('Use default').disabled).toBe(true);
    app.emit({ ...off, port: 45000 });
    expect(app.button('Use default').disabled).toBe(false);
    app.button('Use default').onClick();
    await flush();
    expect(invoke).toHaveBeenCalledWith('fleet:set-port', { port: 43872 });
    expect(app.field().value).toBe('43872');
  });

  it('shows the main-side rejection message and keeps the old port', async () => {
    invoke.mockImplementation((channel: string) =>
      channel === 'fleet:set-port'
        ? Promise.reject(new Error("Error invoking remote method 'fleet:set-port': Error: Fleet port 1000 is already in use"))
        : Promise.resolve(off),
    );
    const app = mount();
    await flush();
    app.field().onChange({ target: { value: '1000' } });
    app.button('Save port').onClick();
    await flush();
    expect(app.markup()).toContain('Fleet port 1000 is already in use');
    expect(app.markup()).not.toContain('Error invoking remote method');
    expect(app.markup()).toContain('sudo ufw allow 43872/tcp');
  });

  it('reflects a remote Fleet event and exposes listener failures', async () => {
    const app = mount();
    app.emit({ ...on, port: 44000, error: 'Fleet network unavailable. Check the firewall.' });
    await flush();
    expect(app.field().value).toBe('44000');
    expect(app.markup()).toContain('Fleet network unavailable');
  });

  it('ignores a delayed initial reply after Fleet announces a newer state', async () => {
    let finish: ((value: FleetState) => void) | undefined;
    invoke.mockImplementation(
      () =>
        new Promise<FleetState>((resolve) => {
          finish = resolve;
        }),
    );
    const app = mount();
    app.emit({ ...on, port: 44000 });
    finish?.(off);
    await flush();
    expect(app.field().value).toBe('44000');
  });

  it('reports a failed initial settings load instead of showing an empty form', async () => {
    invoke.mockRejectedValue(new Error('private network diagnostics'));
    const app = mount();
    await flush();
    expect(app.markup()).toContain('Could not load Fleet settings');
    expect(app.markup()).not.toContain('aria-label="Fleet port"');
    expect(app.markup()).not.toContain('private network diagnostics');
  });
});
