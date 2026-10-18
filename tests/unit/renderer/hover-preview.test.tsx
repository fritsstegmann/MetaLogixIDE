import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IpcResponse } from '@shared/ipc-contract';
import type { HoverPreviewState } from '@renderer/components/HoverPreview';
import { PEEK_COPY, PEEK_TESTIDS } from '@renderer/peek-open';

vi.mock('@renderer/api', () => ({ api: {} }));
vi.stubGlobal('window', { innerWidth: 1200, innerHeight: 800 });
const { HoverPreviewCard } = await import('@renderer/components/HoverPreview');

const state: HoverPreviewState = { x: 10, y: 10, projectId: 1, path: 'a.ts', line: 3 };
const hit: IpcResponse<'files:peek'> = { relPath: 'a.ts', projectId: 1, found: true, kind: 'text', head: 'x', sizeBytes: 1, totalLines: 1 };

function render(data: IpcResponse<'files:peek'> | null, popout = false): string {
  return renderToStaticMarkup(<HoverPreviewCard state={state} data={data} loading={false} popout={popout} onOpen={() => undefined} />);
}

const note = new RegExp(`data-testid="${PEEK_TESTIDS.note}"`);

describe('HoverPreviewCard click affordance', () => {
  it('offers to open a current-project match here, with no note', () => {
    const html = render(hit);
    expect(html).toContain('data-open-action="open-here"');
    expect(html).toContain(PEEK_COPY.openHere);
    expect(html).not.toMatch(note);
  });

  it('offers to switch project for another project match in the main window', () => {
    const html = render({ ...hit, projectId: 2 });
    expect(html).toContain('data-open-action="switch-project"');
    expect(html).toContain(PEEK_COPY.switchProject);
  });

  it('keeps the preview but disables the click with a note for a file outside every project', () => {
    const html = render({ ...hit, relPath: '/elsewhere/a.ts', projectId: null, head: 'loose body' });
    expect(html).toContain('data-open-action="disabled"');
    expect(html).toContain('loose body');
    expect(html).toMatch(new RegExp(`data-testid="${PEEK_TESTIDS.note}"[^>]*>${PEEK_COPY.outsideProjects}<`));
    expect(html).not.toContain(PEEK_COPY.openHere);
  });

  it('disables another project match in a popout with the main-window note', () => {
    const html = render({ ...hit, projectId: 2 }, true);
    expect(html).toContain('data-open-action="disabled"');
    expect(html).toMatch(new RegExp(`data-testid="${PEEK_TESTIDS.note}"[^>]*>${PEEK_COPY.popoutOtherProject}<`));
  });

  it('shows no open hint and no note for a miss', () => {
    const html = render({ ...hit, found: false, projectId: null });
    expect(html).toContain('data-open-action="disabled"');
    expect(html).not.toContain(PEEK_COPY.openHere);
    expect(html).not.toMatch(note);
  });

  it('says a miss was searched for across every project', () => {
    expect(render({ ...hit, found: false, projectId: null })).toContain(`>${PEEK_COPY.notFound}<`);
  });
});
