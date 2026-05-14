import type { AgentCandidate, AgentKind } from '../model';
import type { AgentSource } from '../ports';

/** プロセス名指定の構成 */
export interface ProcessNameSourceConfig {
  /** 検出対象種別 */
  readonly kind: AgentKind;
  /** マッチ対象プロセス名列 */
  readonly commNames: readonly string[];
}

/**
 * プロセス名ベース検出ソースの生成
 * @param config - 検出構成
 * @returns 検出ソース
 */
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
