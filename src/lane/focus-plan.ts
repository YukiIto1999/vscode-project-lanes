import type { Lane, LaneFocusPlan, LaneRootAvailability } from './model';

/**
 * レーンフォーカスの純粋判定
 * @param current - 現活性レーン
 * @param target - 切替先レーン
 * @param targetAvailability - 切替先 root の現在状態
 * @param hasDirtyEditors - 未保存タブの有無
 * @returns 判定結果
 */
export const planLaneFocus = (
  current: Lane | undefined,
  target: Lane | undefined,
  targetAvailability: LaneRootAvailability,
  hasDirtyEditors: boolean,
): LaneFocusPlan => {
  if (!target) return { kind: 'noop', reason: 'no-target' };
  if (targetAvailability !== 'available') {
    return { kind: 'blocked', reason: 'root-unavailable' };
  }
  if (current?.id === target.id) return { kind: 'noop', reason: 'same-lane' };
  if (hasDirtyEditors) return { kind: 'blocked', reason: 'dirty-editors' };
  return { kind: 'focus', from: current, to: target };
};
