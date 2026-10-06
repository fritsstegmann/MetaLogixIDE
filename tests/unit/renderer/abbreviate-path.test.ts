import { describe, expect, it } from 'vitest';
import { abbreviatePath } from '@renderer/abbreviate-path';

describe('abbreviatePath', () => {
  it('replaces the macOS home prefix with ~ and keeps the last segment whole', () => {
    expect(abbreviatePath('/Users/frits/Projects/Personal/Metalogix')).toBe('~/P/P/Metalogix');
  });

  it('abbreviates every leading segment to its first character', () => {
    expect(abbreviatePath('/opt/work/clients/acme')).toBe('/o/w/c/acme');
  });

  it('keeps the dot and the next character of hidden segments', () => {
    expect(abbreviatePath('/Users/frits/.config/nvim')).toBe('~/.c/nvim');
  });

  it('returns ~ for the home directory itself', () => {
    expect(abbreviatePath('/Users/frits')).toBe('~');
    expect(abbreviatePath('/Users/frits/')).toBe('~');
  });

  it('leaves a single-segment path whole', () => {
    expect(abbreviatePath('/Users/frits/Code')).toBe('~/Code');
    expect(abbreviatePath('/srv')).toBe('/srv');
  });

  it('ignores trailing separators', () => {
    expect(abbreviatePath('/opt/work/acme/')).toBe('/o/w/acme');
  });

  it('does not treat a non-home /Users path segment as home', () => {
    expect(abbreviatePath('/Users')).toBe('/Users');
    expect(abbreviatePath('/Volumes/Data/Projects/acme')).toBe('/V/D/P/acme');
  });

  it('abbreviates Windows paths, keeping the drive', () => {
    expect(abbreviatePath('C:\\Users\\frits\\Projects\\acme')).toBe('C:\\U\\f\\P\\acme');
  });

  it('keeps the first full character of a non-ASCII segment', () => {
    expect(abbreviatePath('/opt/Ünïcode/😀emoji/acme')).toBe('/o/Ü/😀/acme');
  });
});
