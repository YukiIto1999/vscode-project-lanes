import { describe, expect, it } from 'vitest';
import type { AbsolutePath, ProcessId, UnixSeconds } from '../foundation/model';
import type { AgentCandidate, AgentKind, ProcSnapshot } from './model';
import { applyHysteresis, judgeActivityRaw } from './activity-policy';

const makeCandidate = (
  lastActivityAt: UnixSeconds | undefined,
  pid: number = 100,
  kind: AgentKind = 'claude-code',
): AgentCandidate => ({
  kind,
  pid: pid as ProcessId,
  cwdPath: '/projects/web' as AbsolutePath,
  lanesSessionId: undefined,
  lastActivityAt,
});

const emptyProc: ProcSnapshot = { observedAt: 1000 as UnixSeconds, processes: [] };

describe('judgeActivityRaw', () => {
  const now = 1000 as UnixSeconds;

  describe('claude-code', () => {
    it('lastActivityAt 未定義なら idle', () => {
      expect(judgeActivityRaw(makeCandidate(undefined), emptyProc, now)).toBe('idle');
    });

    it('1秒以内なら active', () => {
      expect(judgeActivityRaw(makeCandidate(999 as UnixSeconds), emptyProc, now)).toBe('active');
    });

    it('1秒超なら idle', () => {
      expect(judgeActivityRaw(makeCandidate(998 as UnixSeconds), emptyProc, now)).toBe('idle');
    });

    it('子プロセスがあっても lastActivityAt 未定義なら idle', () => {
      const proc: ProcSnapshot = {
        observedAt: now,
        processes: [
          {
            pid: 100 as ProcessId,
            ppid: 1 as ProcessId,
            comm: 'claude',
            cwdPath: '/projects/web' as AbsolutePath,
          },
          {
            pid: 200 as ProcessId,
            ppid: 100 as ProcessId,
            comm: 'uv',
            cwdPath: '/projects/web' as AbsolutePath,
          },
        ],
      };
      expect(judgeActivityRaw(makeCandidate(undefined), proc, now)).toBe('idle');
    });
  });

  describe('codex-cli', () => {
    it('子プロセスがあれば active', () => {
      const proc: ProcSnapshot = {
        observedAt: now,
        processes: [
          {
            pid: 100 as ProcessId,
            ppid: 1 as ProcessId,
            comm: 'codex',
            cwdPath: '/projects/web' as AbsolutePath,
          },
          {
            pid: 200 as ProcessId,
            ppid: 100 as ProcessId,
            comm: 'bash',
            cwdPath: '/projects/web' as AbsolutePath,
          },
        ],
      };
      expect(judgeActivityRaw(makeCandidate(undefined, 100, 'codex-cli'), proc, now)).toBe(
        'active',
      );
    });

    it('子プロセスがなければ idle', () => {
      const proc: ProcSnapshot = {
        observedAt: now,
        processes: [
          {
            pid: 100 as ProcessId,
            ppid: 1 as ProcessId,
            comm: 'codex',
            cwdPath: '/projects/web' as AbsolutePath,
          },
        ],
      };
      expect(judgeActivityRaw(makeCandidate(undefined, 100, 'codex-cli'), proc, now)).toBe('idle');
    });
  });
});

describe('applyHysteresis', () => {
  const now = 1000 as UnixSeconds;

  it('raw が active ならそのまま active', () => {
    expect(applyHysteresis('active', undefined, now, 5)).toBe('active');
  });

  it('raw が idle で lastActiveAt なしなら idle', () => {
    expect(applyHysteresis('idle', undefined, now, 5)).toBe('idle');
  });

  it('raw が idle でも猶予内なら active を維持', () => {
    expect(applyHysteresis('idle', 997 as UnixSeconds, now, 5)).toBe('active');
  });

  it('raw が idle で猶予超過なら idle', () => {
    expect(applyHysteresis('idle', 990 as UnixSeconds, now, 5)).toBe('idle');
  });
});
