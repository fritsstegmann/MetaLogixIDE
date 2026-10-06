/**
 * The main window's centred title: the selected project's name followed by
 * its git branch in pink. With no project it shows the app name; with no
 * branch (no project, or a non-repo project) no branch element renders.
 * Under width pressure the branch, weighted to shrink far faster, truncates
 * before the name does; both carry their full text as a tooltip.
 */
import { CHROME_TESTIDS } from '@renderer/chrome-testids';

export interface TitleGroupProps {
  projectName: string | null;
  branch: string | null;
}

const APP_NAME = 'MetaLogix IDE';

export function TitleGroup({ projectName, branch }: TitleGroupProps) {
  const name = projectName ?? APP_NAME;
  const shownBranch = projectName === null ? null : branch;
  return (
    <span
      className="inline-flex items-baseline gap-2 min-w-0 max-w-full text-[12.5px]"
      data-testid={CHROME_TESTIDS.titleGroup}
    >
      <span
        className="font-medium text-[--text] min-w-0 truncate"
        title={name}
        data-testid={CHROME_TESTIDS.titleName}
      >
        {name}
      </span>
      {shownBranch !== null && (
        <span
          className="text-[--hue-pink] min-w-0 truncate shrink-[100]"
          title={shownBranch}
          data-testid={CHROME_TESTIDS.titleBranch}
        >
          {shownBranch}
        </span>
      )}
    </span>
  );
}
