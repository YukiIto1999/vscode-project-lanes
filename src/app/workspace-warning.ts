import type { WorkspaceDisabledReason } from '../workspace/model';

const WARNING_MESSAGES = {
  'no-workspace-file': undefined,
  'missing-lane-source': undefined,
  'missing-anchor':
    'Project Lanes: Failed to create the .lanes-root anchor. Check write permission for the workspace file directory.',
  'workspace-folder-mutation-rejected':
    'Project Lanes: The workspace folders changed or VS Code rejected the update. Reopen the workspace and try again.',
} satisfies Record<WorkspaceDisabledReason, string | undefined>;

/**
 * ワークスペース無効化理由に対応する警告文
 * @param reason - 無効化理由
 * @returns 表示する警告文、通知不要なら undefined
 */
export const workspaceWarningMessage = (reason: WorkspaceDisabledReason): string | undefined =>
  WARNING_MESSAGES[reason];
