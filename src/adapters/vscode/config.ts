import * as vscode from 'vscode';
import type { AbsolutePath } from '../../foundation/model';
import type { Disposable } from '../../foundation/model';
import type { ConfigPort, ProjectLanesConfig } from '../../app/model';

/** VS Code 設定からの読み取りアダプター */
export const createConfigAdapter = (): ConfigPort => ({
  read: (): ProjectLanesConfig => {
    const cfg = vscode.workspace.getConfiguration('projectLanes');
    return {
      refreshIntervalSec: cfg.get<number>('refreshInterval', 1),
      idleThresholdSec: cfg.get<number>('agent.idleThreshold', 10),
      showAgentStatus: cfg.get<boolean>('agent.showStatus', true),
      shellPath: (cfg.get<string>('terminal.shellPath', '') || undefined) as
        | AbsolutePath
        | undefined,
    };
  },

  onDidChange: (listener): Disposable => {
    const subscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('projectLanes')) {
        const cfg = vscode.workspace.getConfiguration('projectLanes');
        listener({
          refreshIntervalSec: cfg.get<number>('refreshInterval', 1),
          idleThresholdSec: cfg.get<number>('agent.idleThreshold', 10),
          showAgentStatus: cfg.get<boolean>('agent.showStatus', true),
          shellPath: (cfg.get<string>('terminal.shellPath', '') || undefined) as
            | AbsolutePath
            | undefined,
        });
      }
    });
    return { dispose: () => subscription.dispose() };
  },
});
