import { describe, expect, it } from 'vitest';
import type { WorkspaceDisabledReason } from '../workspace/model';
import { workspaceWarningMessage } from './workspace-warning';

const cases = {
  'no-workspace-file': undefined,
  'missing-lane-source': undefined,
  'missing-anchor':
    'Project Lanes: Failed to create the .lanes-root anchor. Check write permission for the workspace file directory.',
  'workspace-folder-mutation-rejected':
    'Project Lanes: The workspace folders changed or VS Code rejected the update. Reopen the workspace and try again.',
} satisfies Record<WorkspaceDisabledReason, string | undefined>;

describe('workspaceWarningMessage', () => {
  it.each(Object.entries(cases) as [WorkspaceDisabledReason, string | undefined][])(
    '%s の通知文を返す',
    (reason, expected) => {
      expect(workspaceWarningMessage(reason)).toBe(expected);
    },
  );
});
