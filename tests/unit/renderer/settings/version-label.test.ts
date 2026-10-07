import { describe, it, expect } from 'vitest';
import { readAppVersion, versionLabel } from '@renderer/components/settings/version-label';

describe('versionLabel', () => {
  it('appends the version to the wordmark', () => {
    expect(versionLabel('0.3.6')).toBe('MetaLogix IDE 0.3.6');
  });

  it('shows the wordmark alone when the version is unknown', () => {
    expect(versionLabel(null)).toBe('MetaLogix IDE');
  });

  it('shows the wordmark alone when the version is empty', () => {
    expect(versionLabel('')).toBe('MetaLogix IDE');
  });

  it('never mentions a phase', () => {
    expect(versionLabel('1.0.0')).not.toMatch(/phase/i);
    expect(versionLabel(null)).not.toMatch(/phase/i);
  });
});

describe('readAppVersion', () => {
  it('resolves to the version the IPC returns', async () => {
    await expect(readAppVersion(() => Promise.resolve({ version: '0.3.6' }))).resolves.toBe(
      '0.3.6',
    );
  });

  it('resolves to null instead of rejecting when the IPC fails', async () => {
    await expect(readAppVersion(() => Promise.reject(new Error('no ipc')))).resolves.toBeNull();
  });

  it('resolves to null when the invoker throws synchronously', async () => {
    const invoke = (): Promise<{ version: string }> => {
      throw new Error('bridge missing');
    };
    await expect(readAppVersion(invoke)).resolves.toBeNull();
  });
});
