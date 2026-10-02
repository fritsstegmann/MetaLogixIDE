/** Exact user-facing strings and test ids for the per-project environment variables editor. */
export const ENV_COPY = {
  headerButton: 'Environment variables', // Tooltip label + aria-label
  contextMenuItem: 'Environment variables…',
  dialogTitle: 'Environment variables', // dialog accessible name; project name shown as subtitle
  emptyState: 'No environment variables for this project.',
  noticeNewShells:
    'Changes apply to newly opened shells only. Shells that are already running keep their current environment.',
  noticeUnencrypted: 'Values are stored unencrypted on this machine.',
  tokensHint:
    'Values can use ${HOME}, ${PROJECT_PATH}, ${PROJECT_NAME} and ${env.NAME}. To extend PATH: ${PROJECT_PATH}/node_modules/.bin:${env.PATH}',
  nameLabel: (row: number) => `Name, row ${row}`,
  valueLabel: (row: number) => `Value, row ${row}`,
  removeLabel: (row: number) => `Remove variable, row ${row}`,
  addRow: 'Add variable',
  save: 'Save',
  cancel: 'Cancel',
  close: 'Close',
  saveFailed: 'Could not save environment variables',
  reason: {
    invalid: 'Use letters, digits and _, not starting with a digit',
    'too-long': 'Name must be 255 characters or fewer',
    reserved: 'Reserved — names starting with METAIDE_ are used by the app',
    duplicate: 'Duplicate name',
    nul: 'Value contains a NUL character',
  },
} as const;
export const ENV_TESTIDS = {
  headerButton: 'project-env-open',
  dialog: 'project-env-dialog',
  row: 'project-env-row',
  name: 'project-env-name',
  value: 'project-env-value',
  remove: 'project-env-remove',
  reason: 'project-env-reason',
  add: 'project-env-add',
  save: 'project-env-save',
  cancel: 'project-env-cancel',
  empty: 'project-env-empty',
} as const;
