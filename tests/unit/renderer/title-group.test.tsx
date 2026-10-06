import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TitleGroup } from '@renderer/components/TitleGroup';
import { CHROME_TESTIDS } from '@renderer/chrome-testids';

interface Found {
  tag: string;
  classes: string[];
  attrs: string;
  text: string;
}

function render(projectName: string | null, branch: string | null): string {
  return renderToStaticMarkup(<TitleGroup projectName={projectName} branch={branch} />);
}

function count(html: string, testId: string): number {
  return html.split(`data-testid="${testId}"`).length - 1;
}

function find(html: string, testId: string): Found {
  const re = new RegExp(`<(\\w+)([^>]*data-testid="${testId}"[^>]*)>([^<]*)`);
  const match = re.exec(html);
  if (!match?.[1] || match[2] === undefined) throw new Error(`no element ${testId} in ${html}`);
  const classes = /class="([^"]*)"/.exec(match[2])?.[1]?.split(/\s+/) ?? [];
  return { tag: match[1], classes, attrs: match[2], text: match[3] ?? '' };
}

describe('TitleGroup', () => {
  it('shows the project name and the branch inside one title group', () => {
    const html = render('demo', 'main');
    expect(count(html, CHROME_TESTIDS.titleGroup)).toBe(1);
    expect(find(html, CHROME_TESTIDS.titleName).text).toBe('demo');
    expect(find(html, CHROME_TESTIDS.titleBranch).text).toBe('main');
    const group = html.indexOf(`data-testid="${CHROME_TESTIDS.titleGroup}"`);
    expect(group).toBeLessThan(html.indexOf(`data-testid="${CHROME_TESTIDS.titleName}"`));
    expect(group).toBeLessThan(html.indexOf(`data-testid="${CHROME_TESTIDS.titleBranch}"`));
  });

  it('places the branch after the name', () => {
    const html = render('demo', 'main');
    expect(html.indexOf(`data-testid="${CHROME_TESTIDS.titleName}"`))
      .toBeLessThan(html.indexOf(`data-testid="${CHROME_TESTIDS.titleBranch}"`));
  });

  it('colours the branch pink and lets it truncate first', () => {
    const branch = find(render('demo', 'main'), CHROME_TESTIDS.titleBranch);
    expect(branch.classes).toContain('text-[--hue-pink]');
    expect(branch.classes).toContain('truncate');
    expect(branch.classes).toContain('min-w-0');
  });

  it('truncates a long project name instead of overflowing', () => {
    const name = find(render('demo', 'main'), CHROME_TESTIDS.titleName);
    expect(name.classes).toContain('truncate');
  });

  it('exposes the full name and branch as a tooltip for truncated text', () => {
    const html = render('a-very-long-project', 'feature/very-long-branch');
    expect(find(html, CHROME_TESTIDS.titleName).attrs).toContain('title="a-very-long-project"');
    expect(find(html, CHROME_TESTIDS.titleBranch).attrs).toContain('title="feature/very-long-branch"');
  });

  it('renders no branch element when the branch is null (AC5)', () => {
    const html = render('demo', null);
    expect(count(html, CHROME_TESTIDS.titleBranch)).toBe(0);
    expect(find(html, CHROME_TESTIDS.titleName).text).toBe('demo');
  });

  it('falls back to the app name with no branch when no project is selected (AC6)', () => {
    const html = render(null, null);
    expect(find(html, CHROME_TESTIDS.titleName).text).toBe('MetaLogix IDE');
    expect(count(html, CHROME_TESTIDS.titleBranch)).toBe(0);
  });

  it('never shows a branch without a project (AC5)', () => {
    const html = render(null, 'main');
    expect(find(html, CHROME_TESTIDS.titleName).text).toBe('MetaLogix IDE');
    expect(count(html, CHROME_TESTIDS.titleBranch)).toBe(0);
    expect(html).not.toContain('>main<');
  });

  it('sets the title text at 12.5px (AC6)', () => {
    const group = find(render('demo', 'main'), CHROME_TESTIDS.titleGroup);
    expect(group.classes).toContain('text-[12.5px]');
  });
});
