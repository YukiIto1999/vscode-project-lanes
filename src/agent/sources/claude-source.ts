import type { AbsolutePath, ProcessId } from '../../foundation/model';
import type { AgentCandidate } from '../model';
import type { AgentSource, ClaudeSessionPort } from '../ports';

/** Claude Code エージェントの検出ソース */
export const createClaudeSource = (
  homePath: AbsolutePath,
  sessionPort: ClaudeSessionPort,
): AgentSource => ({
  kind: 'claude-code',

  collect: (context) => {
    const records = sessionPort.list(homePath);
    const procByPid = new Map(context.proc.processes.map((p) => [p.pid, p]));

    const bestByPid = new Map<ProcessId, AgentCandidate>();

    for (const record of records) {
      const proc = procByPid.get(record.pid);
      if (!proc) continue;
      if (proc.comm !== 'claude') continue;
      if (!proc.cwdPath || proc.cwdPath !== record.cwdPath) continue;

      const existing = bestByPid.get(record.pid);
      const existingAt = existing?.lastActivityAt ?? 0;
      const currentAt = record.journalUpdatedAt ?? 0;

      if (!existing || currentAt > existingAt) {
        bestByPid.set(record.pid, {
          kind: 'claude-code',
          pid: record.pid,
          cwdPath: record.cwdPath,
          lanesSessionId: undefined,
          lastActivityAt: record.journalUpdatedAt,
        });
      }
    }

    return [...bestByPid.values()];
  },
});
