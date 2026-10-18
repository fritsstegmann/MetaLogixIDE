import { describe, it, expect } from 'vitest';
import { createPendingFileOpen } from '@renderer/pending-file-open';

const file = { relPath: 'shared.txt', line: 4 };

describe('createPendingFileOpen', () => {
  it('hands the open to the selection change that lands on its project, even when the pick settled first', () => {
    const pending = createPendingFileOpen();
    pending.request(2, file);
    pending.pickSettled(2, true);
    expect(pending.take(2)).toEqual(file);
  });

  it('hands the open to the selection change that lands before the pick settles', () => {
    const pending = createPendingFileOpen();
    pending.request(2, file);
    expect(pending.take(2)).toEqual(file);
    pending.pickSettled(2, true);
    expect(pending.take(2)).toBeNull();
  });

  it('is the value the project-change effect applies, so the clear on project change cannot wipe it', () => {
    const pending = createPendingFileOpen();
    pending.request(2, file);
    const openInFilesAfterSwitch = pending.take(2);
    expect(openInFilesAfterSwitch).toEqual(file);
  });

  it('opens once: a later selection of the same project gets nothing', () => {
    const pending = createPendingFileOpen();
    pending.request(2, file);
    pending.take(2);
    expect(pending.take(2)).toBeNull();
  });

  it('drops the open when the selection lands on another project (superseded)', () => {
    const pending = createPendingFileOpen();
    pending.request(2, file);
    expect(pending.take(3)).toBeNull();
    expect(pending.take(2)).toBeNull();
  });

  it('drops the open when the switch did not select its project, so a later manual pick does not open it', () => {
    const pending = createPendingFileOpen();
    pending.request(2, file);
    pending.pickSettled(2, false);
    expect(pending.take(2)).toBeNull();
  });

  it('keeps a newer request when an older switch to another project settles unselected', () => {
    const pending = createPendingFileOpen();
    pending.request(2, file);
    pending.request(3, { relPath: 'b', line: null });
    pending.pickSettled(2, false);
    expect(pending.take(3)).toEqual({ relPath: 'b', line: null });
  });

  it('gives nothing when nothing was requested or nothing is selected', () => {
    const pending = createPendingFileOpen();
    expect(pending.take(2)).toBeNull();
    pending.request(2, file);
    expect(pending.take(null)).toBeNull();
  });
});
