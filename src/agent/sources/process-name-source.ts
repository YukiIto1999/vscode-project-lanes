import type { AgentCandidate, AgentKind } from '../model';
import type { AgentSource } from '../ports';

/** プロセス名指定の構成 */
export interface ProcessNameSourceConfig {
  readonly kind: AgentKind;
  readonly commNames: readonly string[];
}

/** プロセス名ベースのエージェント検出ソース（Codex/Copilot/Gemini 共通） */
export const createProcessNameSource = (config: ProcessNameSourceConfig): AgentSource => ({
  kind: config.kind,

  collect: (context) =>
    context.proc.processes.flatMap((proc): AgentCandidate[] => {
      if (!config.commNames.includes(proc.comm)) return [];
      if (!proc.cwdPath) return [];
      return [
        {
          kind: config.kind,
          pid: proc.pid,
          cwdPath: proc.cwdPath,
          lanesSessionId: undefined,
          lastActivityAt: undefined,
        },
      ];
    }),
});
