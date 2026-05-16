import { describe, expect, it } from 'vitest';
import type { AbsolutePath } from '../foundation/model';
import { planActiveLinkSwap } from './active-link';

const linkPath = '/ws/.lanes-root/active' as AbsolutePath;

describe('planActiveLinkSwap', () => {
  it('同一 target なら undefined', () => {
    const p = '/p/a' as AbsolutePath;
    expect(planActiveLinkSwap(linkPath, p, p)).toBeUndefined();
  });

  it('異なる target なら plan を返す', () => {
    const from = '/p/a' as AbsolutePath;
    const to = '/p/b' as AbsolutePath;
    expect(planActiveLinkSwap(linkPath, from, to)).toEqual({ linkPath, from, to });
  });

  it('初回 swap のため from が undefined でも plan を返す', () => {
    const to = '/p/b' as AbsolutePath;
    expect(planActiveLinkSwap(linkPath, undefined, to)).toEqual({ linkPath, from: undefined, to });
  });
});
