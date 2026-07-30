import type { LaneRelocationPlan } from '../lane/relocation-plan';

const WARNING_MESSAGES = {
  'replacement-unavailable': 'The selected folder is unavailable. Choose a readable folder.',
  'duplicate-root': 'The selected folder is already registered as another lane.',
} satisfies Record<Extract<LaneRelocationPlan, { kind: 'rejected' }>['reason'], string>;

/**
 * レーン所在変更結果に対応する警告文
 * @param plan - レーン所在変更計画
 * @returns 表示する警告文、通知不要なら undefined
 */
export const laneRelocationWarningMessage = (
  plan: LaneRelocationPlan | undefined,
): string | undefined => (plan?.kind === 'rejected' ? WARNING_MESSAGES[plan.reason] : undefined);
