/** User-facing copy for the sidebar header, "+" menu and section headings. */
export const SIDEBAR_COPY = {
  filterPlaceholder: 'Filter projects',
  filterLabel: 'Filter projects',
  addButtonLabel: 'New project',
  menuNewProject: 'New project…',
  menuNewProjectHint: '⌘⇧N',
  menuAddRoot: 'Add root folder…',
  menuRescan: 'Rescan roots',
  menuRescanning: 'Rescanning…',
  projectsHeading: 'Projects',
} as const;

/** Test ids shared by the sidebar header, its "+" menu and the e2e suite. */
export const SIDEBAR_TESTIDS = {
  filter: 'sidebar-filter',
  addButton: 'sidebar-add-btn',
  menuNewProject: 'sidebar-add-new-project',
  menuAddRoot: 'sidebar-add-root',
  menuRescan: 'sidebar-add-rescan',
  sectionAll: 'section-all',
} as const;

/** localStorage collapse keys; 'All projects' is the pre-rename key, kept so stored state survives. */
export const SECTION_PERSIST_KEYS = { projects: 'All projects' } as const;
