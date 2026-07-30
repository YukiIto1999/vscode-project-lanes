import { describe, expect, it } from 'vitest';
import type { LaneRelocationPlan } from '../lane/relocation-plan';
import { laneRelocationWarningMessage } from './lane-relocation-warning';

describe('laneRelocationWarningMessage', () => {
  it.each([
    [
      { kind: 'rejected', reason: 'replacement-unavailable' },
      'The selected folder is unavailable. Choose a readable folder.',
    ],
    [
      { kind: 'rejected', reason: 'duplicate-root' },
      'The selected folder is already registered as another lane.',
    ],
    [
      { kind: 'blocked', reason: 'root-unavailable' },
      'The selected folder became unavailable. Choose it again.',
    ],
    [
      { kind: 'blocked', reason: 'reconciliation-required' },
      'The active lane changed. Retry locating the folder.',
    ],
  ] satisfies ReadonlyArray<readonly [LaneRelocationPlan, string]>)(
    '%o の警告文を返す',
    (plan, expected) => {
      expect(laneRelocationWarningMessage(plan)).toBe(expected);
    },
  );

  it.each([
    undefined,
    { kind: 'noop', reason: 'no-target' },
    { kind: 'noop', reason: 'same-root' },
    { kind: 'blocked', reason: 'dirty-editors' },
  ] satisfies ReadonlyArray<LaneRelocationPlan | undefined>)('%o は通知しない', (plan) => {
    expect(laneRelocationWarningMessage(plan)).toBeUndefined();
  });
});
