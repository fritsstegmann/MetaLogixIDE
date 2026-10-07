import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PresenceContext } from 'motion/react';
import { ContextMenu } from '@renderer/components/ContextMenu';

vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), useEffect: (fn: () => void) => { fn(); } }));

const items = [{ label: 'Paste', onClick: () => undefined }];
const render = (isPresent: boolean): string =>
  renderToStaticMarkup(
    createElement(
      PresenceContext.Provider,
      { value: { id: 'x', isPresent, initial: false, custom: undefined, onExitComplete: () => undefined, register: () => () => undefined } },
      createElement(ContextMenu, { x: 1, y: 2, items, onClose: () => undefined }),
    ),
  );

afterEach(() => vi.unstubAllGlobals());

describe('leaving ContextMenu is non-interactive', () => {
  it('present menu is not inert', () => {
    vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600, addEventListener: () => undefined, removeEventListener: () => undefined });
    expect(render(true)).not.toContain('inert');
  });

  it('leaving menu is inert so Enter/Space on a focused item cannot run it again', () => {
    vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600, addEventListener: () => undefined, removeEventListener: () => undefined });
    expect(render(false)).toContain('inert=""');
  });

  it('attaches the Escape listener only while present', () => {
    const add = vi.fn();
    vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600, addEventListener: add, removeEventListener: () => undefined });
    render(false);
    expect(add).not.toHaveBeenCalledWith('keydown', expect.anything());
    render(true);
    expect(add).toHaveBeenCalledWith('keydown', expect.any(Function));
  });
});
