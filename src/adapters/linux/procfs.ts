import * as fs from 'node:fs';
import type { AbsolutePath, ProcessId, UnixSeconds } from '../../foundation/model';
import type { ProcProcessSnapshot, ProcSnapshot } from '../../agent/model';
import type { ProcEnvPort, ProcSnapshotPort } from '../../agent/ports';

/**
 * 親プロセス識別子の取得
 * @param pid - 対象プロセス識別子
 * @returns 親プロセス識別子、または取得失敗で 0
 */
const readPpid = (pid: ProcessId): ProcessId => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
    const ppid = Number(afterComm.split(' ')[1]);
    return (Number.isInteger(ppid) ? ppid : 0) as ProcessId;
  } catch {
    return 0 as ProcessId;
  }
};

/**
 * プロセス名の取得
 * @param pid - 対象プロセス識別子
 * @returns プロセス名、または取得失敗で undefined
 */
const readComm = (pid: ProcessId): string | undefined => {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
  } catch {
    return undefined;
  }
};

/**
 * 作業ディレクトリの取得
 * @param pid - 対象プロセス識別子
 * @returns 作業ディレクトリ絶対パス、または取得失敗で undefined
 */
const readCwd = (pid: ProcessId): AbsolutePath | undefined => {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`) as AbsolutePath;
  } catch {
    return undefined;
  }
};

/**
 * プロセス全体スナップショット取得アダプターの生成
 * @returns スナップショット取得ポート
 */
export const createProcSnapshotAdapter = (): ProcSnapshotPort => ({
  read: (): ProcSnapshot => {
    const now = Math.floor(Date.now() / 1000) as UnixSeconds;
    try {
      const entries = fs.readdirSync('/proc');
      const processes: ProcProcessSnapshot[] = entries.flatMap((entry) => {
        const pid = Number(entry);
        if (!Number.isInteger(pid) || pid <= 0) return [];
        const comm = readComm(pid as ProcessId);
        if (!comm) return [];
        return [
          {
            pid: pid as ProcessId,
            ppid: readPpid(pid as ProcessId),
            comm,
            cwdPath: readCwd(pid as ProcessId),
          },
        ];
      });
      return { observedAt: now, processes };
    } catch {
      return { observedAt: now, processes: [] };
    }
  },
});

/**
 * プロセス環境変数読み取りアダプターの生成
 * @returns 環境変数読み取りポート
 */
export const createProcEnvAdapter = (): ProcEnvPort => ({
  readEnvVar: (pid, name) => {
    try {
      const environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf-8');
      const prefix = `${name}=`;
      const entry = environ.split('\0').find((e) => e.startsWith(prefix));
      return entry ? entry.slice(prefix.length) : undefined;
    } catch {
      return undefined;
    }
  },
});
