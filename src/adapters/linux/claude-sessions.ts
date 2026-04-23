import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import type { AbsolutePath, ProcessId, UnixSeconds } from '../../foundation/model';
import type { ClaudeSessionRecord } from '../../agent/model';
import type { ClaudeSessionPort } from '../../agent/ports';

/**
 * cwd から Claude プロジェクトディレクトリ名への変換
 * @param cwd - 作業ディレクトリ
 * @returns プロジェクトディレクトリ名
 */
const cwdToProjectDir = (cwd: string): string => cwd.replaceAll('/', '-');

/**
 * Claude セッション読み取りアダプターの生成
 * @returns Claude セッション読み取りポート
 */
export const createClaudeSessionAdapter = (): ClaudeSessionPort => ({
  list: (homePath) => {
    const sessionsDir = nodePath.join(homePath, '.claude', 'sessions');
    try {
      const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
      return files.flatMap((f): ClaudeSessionRecord[] => {
        const raw = (() => {
          try {
            return fs.readFileSync(nodePath.join(sessionsDir, f), 'utf-8');
          } catch {
            return undefined;
          }
        })();
        if (!raw) return [];

        try {
          const content: unknown = JSON.parse(raw);
          if (typeof content !== 'object' || content === null) return [];
          const { pid, cwd, sessionId } = content as Record<string, unknown>;
          if (typeof pid !== 'number' || typeof cwd !== 'string' || typeof sessionId !== 'string') {
            return [];
          }

          const journalUpdatedAt = (() => {
            try {
              const journalPath = nodePath.join(
                homePath,
                '.claude',
                'projects',
                cwdToProjectDir(cwd),
                `${sessionId}.jsonl`,
              );
              const stat = fs.statSync(journalPath);
              return Math.floor(stat.mtimeMs / 1000) as UnixSeconds;
            } catch {
              return undefined;
            }
          })();

          return [
            {
              pid: pid as ProcessId,
              cwdPath: cwd as AbsolutePath,
              sessionId,
              journalUpdatedAt,
            },
          ];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  },
});
