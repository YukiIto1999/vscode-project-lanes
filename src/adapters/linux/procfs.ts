import * as fs from 'node:fs';
import type { AbsolutePath, ProcessId, UnixSeconds } from '../../foundation/model';
import type { ProcProcessSnapshot, ProcSnapshot } from '../../agent/model';
import type { ProcEnvPort, ProcSnapshotPort } from '../../agent/ports';

/** /proc/{pid}/stat から ppid を取得（4番目のフィールド） */
const readPpid = (pid: ProcessId): ProcessId => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // format: "pid (comm) state ppid ..."
    // comm にスペースや括弧を含む可能性があるため、最後の ')' 以降をパース
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
    const ppid = Number(afterComm.split(' ')[1]);
    return (Number.isInteger(ppid) ? ppid : 0) as ProcessId;
  } catch {
    return 0 as ProcessId;
  }
};

/** プロセス名の取得 */
const readComm = (pid: ProcessId): string | undefined => {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
  } catch {
    return undefined;
  }
};

/** プロセスの cwd 取得 */
const readCwd = (pid: ProcessId): AbsolutePath | undefined => {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`) as AbsolutePath;
  } catch {
    return undefined;
  }
};

/** /proc からプロセスのスナップショット取得 */
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

/** /proc/{pid}/environ からの環境変数読み取りアダプター */
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
