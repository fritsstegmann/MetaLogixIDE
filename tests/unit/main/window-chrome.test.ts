import { describe, it, expect } from 'vitest';
import { platformChrome, rendererQuery } from '@main/window-chrome';

describe('platformChrome (AC18, AC26)', () => {
  it('darwin: visualEffectState is followWindow, every other baseline option is unchanged', () => {
    expect(platformChrome('darwin')).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 14 },
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
      roundedCorners: true,
    });
  });

  it.each(['win32', 'linux'] as const)('%s: deep-equals the baseline, unchanged', (platform) => {
    expect(platformChrome(platform)).toEqual({ autoHideMenuBar: true });
  });
});

describe('rendererQuery (AC7, AC13)', () => {
  it('darwin + stored true => frostTerminal=1', () => {
    expect(rendererQuery({ frostTerminal: true, platform: 'darwin' })).toBe('frostTerminal=1');
  });

  it('darwin + stored false => frostTerminal=0', () => {
    expect(rendererQuery({ frostTerminal: false, platform: 'darwin' })).toBe('frostTerminal=0');
  });

  it.each(['win32', 'linux'] as const)('%s + stored true still => frostTerminal=0 (AC13)', (platform) => {
    expect(rendererQuery({ frostTerminal: true, platform })).toBe('frostTerminal=0');
  });

  it('popout: keeps popout, projectId and shellIndex alongside frostTerminal', () => {
    expect(rendererQuery({ popout: { projectId: 3, shellIndex: 1 }, frostTerminal: true, platform: 'darwin' }))
      .toBe('popout=1&projectId=3&shellIndex=1&frostTerminal=1');
  });

  it('popout on non-mac: frostTerminal=0, popout params unchanged', () => {
    expect(rendererQuery({ popout: { projectId: 3, shellIndex: 1 }, frostTerminal: true, platform: 'win32' }))
      .toBe('popout=1&projectId=3&shellIndex=1&frostTerminal=0');
  });
});
