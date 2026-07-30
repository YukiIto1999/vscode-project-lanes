import type { LaneRelocationPlan } from '../lane/relocation-plan';

const WARNING_MESSAGES = {
  'replacement-unavailable': 'The selected folder is unavailable. Choose a readable folder.',
  'duplicate-root': 'The selected folder is already registered as another lane.',
} satisfies Record<Extract<LaneRelocationPlan, { kind: 'rejected' }>['reason'], string>;

const BLOCKED_WARNING_MESSAGES = {
  'root-unavailable': 'The selected folder became unavailable. Choose it again.',
  'reconciliation-required': 'The active lane changed. Retry locating the folder.',
} satisfies Record<
  Exclude<Extract<LaneRelocationPlan, { kind: 'blocked' }>['reason'], 'dirty-editors'>,
  string
>;

/**
 * レーン所在変更結果に対応する警告文
 * @param plan - レーン所在変更計画
 * @returns 表示する警告文、通知不要なら undefined
 */
export const laneRelocationWarningMessage = (
  plan: LaneRelocationPlan | undefined,
): string | undefined => {
  if (plan?.kind === 'rejected') return WARNING_MESSAGES[plan.reason];
  if (plan?.kind !== 'blocked' || plan.reason === 'dirty-editors') return undefined;
  return BLOCKED_WARNING_MESSAGES[plan.reason];
};
