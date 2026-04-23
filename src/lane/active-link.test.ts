import { describe, expect, it, vi } from 'vitest';
import type { AbsolutePath } from '../foundation/model';
import type { WorkspaceLinkPort } from '../workspace/ports';
import { executeActiveLinkSwap, planActiveLinkSwap } from './active-link';

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

  it('from が undefined でも plan を返す（初回 swap）', () => {
    const to = '/p/b' as AbsolutePath;
    expect(planActiveLinkSwap(linkPath, undefined, to)).toEqual({ linkPath, from: undefined, to });
  });
});

describe('executeActiveLinkSwap', () => {
  it('port.swap を target 引数で呼ぶ', () => {
    const swap = vi.fn();
    const port: WorkspaceLinkPort = {
      linkPath,
      readTarget: () => undefined,
      swap,
    };
    executeActiveLinkSwap({ linkPath, from: undefined, to: '/p/b' as AbsolutePath }, port);
    expect(swap).toHaveBeenCalledWith('/p/b');
  });
});
