import type { Lane, LaneFocusPlan } from './model';

/** レーンフォーカスの純粋判定 */
export const planLaneFocus = (
  current: Lane | undefined,
  target: Lane | undefined,
  hasDirtyEditors: boolean,
): LaneFocusPlan => {
  if (!target) return { kind: 'noop', reason: 'no-target' };
  if (current?.id === target.id) return { kind: 'noop', reason: 'same-lane' };
  if (hasDirtyEditors) return { kind: 'blocked', reason: 'dirty-editors' };
  return { kind: 'focus', from: current, to: target };
};
