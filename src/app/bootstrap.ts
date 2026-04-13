import * as vscode from 'vscode';
import type { AbsolutePath, LaneId, SessionId, UnixSeconds, UriString } from '../foundation/model';
import { createConfigAdapter } from '../adapters/vscode/config';
import { createSelectionStoreAdapter } from '../adapters/vscode/storage';
import { createEditorAdapter } from '../adapters/vscode/editors';
import {
  createDirectoryAdapter,
  createWorkspaceHostAdapter,
  createWorkspaceSettingsAdapter,
} from '../adapters/vscode/workspace';
import { createTerminalPresentationAdapter } from '../adapters/vscode/terminals';
import { createTreeViewAdapter } from '../adapters/vscode/tree-view';
import { createStatusBarAdapter } from '../adapters/vscode/status-bar';
import { createPromptAdapter } from '../adapters/vscode/quick-pick';
import { createTimerAdapter } from '../adapters/vscode/timers';
import { createProcSnapshotAdapter, createProcEnvAdapter } from '../adapters/linux/procfs';
import { createClaudeSessionAdapter } from '../adapters/linux/claude-sessions';
import { createShellSessionFactory } from '../adapters/pty/node-pty';
import { bootstrapWorkspace } from '../workspace/scanner';
import { planFocusLane, planRevealAll } from '../workspace/folder-plan';
import { createLaneService } from '../lane/service';
import { createTerminalService } from '../terminal/service';
import { createAgentMonitorService } from '../agent/service';
import { createDefaultSources } from '../agent/sources/default-sources';
import { projectUi } from '../ui/projections';
import type { ProjectLanesRuntime } from './model';

/** 拡張機能の組み立てと起動 */
export const bootstrapRuntime = (
  context: vscode.ExtensionContext,
): ProjectLanesRuntime | undefined => {
  // ワークスペースブートストラップ
  const workspaceHost = createWorkspaceHostAdapter();
  const directory = createDirectoryAdapter();
  const toUri = (path: string): UriString => vscode.Uri.file(path).toString() as UriString;

  const result = bootstrapWorkspace(workspaceHost, directory, toUri);
  if (result.kind === 'disabled') return undefined;

  const { context: wsContext } = result;
  const { anchor, catalog } = wsContext;

  // ワークスペース設定（既存設定をマージ）
  const settings = createWorkspaceSettingsAdapter();
  settings.hideAnchor(anchor);

  // アダプター構築
  const config = createConfigAdapter();
  const editor = createEditorAdapter();
  const selectionStore = createSelectionStoreAdapter(context.workspaceState);
  const prompt = createPromptAdapter();
  const timer = createTimerAdapter();
  const shellFactory = createShellSessionFactory();
  const presentation = createTerminalPresentationAdapter();
  const procSnapshot = createProcSnapshotAdapter();
  const procEnv = createProcEnvAdapter();
  const claudeSession = createClaudeSessionAdapter();

  // セッション ID 採番
  const instanceId = process.pid;
  const laneCounters = new Map<LaneId, number>();
  const sessionIdPort = {
    next: (laneId: LaneId): SessionId => {
      const n = (laneCounters.get(laneId) ?? 0) + 1;
      laneCounters.set(laneId, n);
      return `${laneId}:${instanceId}:${n}` as SessionId;
    },
  };

  // ターミナルサービス
  const terminalService = createTerminalService({
    shellFactory,
    presentation,
    sessionId: sessionIdPort,
    getShellPath: () => config.read().shellPath,
  });

  // レーンサービス
  const laneService = createLaneService({
    catalog,
    workspaceKey: wsContext.key,
    editor,
    visibility: {
      focusLane: (lane) => {
        const folders = workspaceHost.readFolders();
        workspaceHost.applyMutation(planFocusLane(folders.length, lane));
      },
      revealAllLanes: () => {
        const folders = workspaceHost.readFolders();
        workspaceHost.applyMutation(planRevealAll(folders.length, catalog));
      },
    },
    terminal: {
      revealLane: async (lane) => terminalService.revealLane(lane),
      closeLane: async (laneId) => terminalService.closeLane(laneId),
    },
    selectionStore,
    prompt,
  });

  // エージェントモニタ（閾値を動的参照）
  const homePath = (process.env.HOME || `/home/${process.env.USER}`) as AbsolutePath;
  const agentSources = createDefaultSources(homePath, claudeSession);
  const agentMonitor = createAgentMonitorService({
    proc: procSnapshot,
    procEnv,
    clock: { nowSeconds: () => Math.floor(Date.now() / 1000) as UnixSeconds },
    sources: agentSources,
    getIdleThresholdSec: () => config.read().idleThresholdSec,
  });

  // UI
  const treeView = createTreeViewAdapter();
  const statusBar = createStatusBarAdapter();

  /** 全 UI の再描画 */
  const render = () => {
    const cfg = config.read();
    const snapshot = projectUi(
      laneService.snapshot(),
      agentMonitor.snapshot(),
      cfg.showAgentStatus,
    );
    treeView.render(snapshot);
    statusBar.render(snapshot.statusBar);
  };

  /** エージェント状態の更新と再描画 */
  const refreshAndRender = () => {
    try {
      agentMonitor.refresh(catalog, terminalService.managedSessionIds());
    } catch {
      // /proc 読み取りエラー等は無視して前回のスナップショットを維持
    }
    render();
  };

  // 定期更新
  const cfg = config.read();
  let refreshDisposable = timer.every(cfg.refreshIntervalSec * 1000, refreshAndRender);

  // 設定変更時にタイマーを再構成し即時反映
  const configDisposable = config.onDidChange((newCfg) => {
    refreshDisposable.dispose();
    refreshDisposable = timer.every(newCfg.refreshIntervalSec * 1000, refreshAndRender);
    refreshAndRender();
  });

  // 初期レンダリング
  refreshAndRender();

  // 起動時にアクティブレーンのターミナルを復元
  const initialLane = laneService.snapshot().activeLaneId;
  if (initialLane) {
    const lane = catalog.byId.get(initialLane);
    if (lane) terminalService.revealLane(lane);
  }

  render();

  // コマンド登録
  const focusCommand = vscode.commands.registerCommand('projectLanes.focus', (laneId?: string) =>
    laneService.focus(laneId as LaneId | undefined).then(() => render()),
  );

  const unfocusCommand = vscode.commands.registerCommand('projectLanes.unfocus', () => {
    laneService.unfocus();
    render();
  });

  const closeTerminalsCommand = vscode.commands.registerCommand('projectLanes.closeTerminals', () =>
    laneService.closeActiveLaneTerminals(),
  );

  // ターミナルプロファイル（+ボタンで新セッションを追加）
  const profileProvider = vscode.window.registerTerminalProfileProvider('projectLanes.terminal', {
    provideTerminalProfile: () => {
      const activeLaneId = laneService.snapshot().activeLaneId;
      if (!activeLaneId) return undefined;
      const lane = catalog.byId.get(activeLaneId);
      if (!lane) return undefined;
      terminalService.addTerminal(lane);
      return undefined;
    },
  });

  // ターミナルクローズイベント（presentation adapter のクリーンアップ + 即時 UI 更新）
  const terminalCloseHandler = vscode.window.onDidCloseTerminal((terminal) => {
    const terminalId = presentation.resolveId(terminal);
    if (terminalId) {
      presentation.disposeTerminal(terminalId);
      terminalService.handleTerminalClosed(terminalId);
      refreshAndRender();
    }
  });

  // サブスクリプション登録
  context.subscriptions.push(
    focusCommand,
    unfocusCommand,
    closeTerminalsCommand,
    profileProvider,
    terminalCloseHandler,
    statusBar.disposable,
    ...treeView.disposables,
    configDisposable,
    { dispose: () => refreshDisposable.dispose() },
    { dispose: () => terminalService.dispose() },
  );

  return {
    initialize: async () => {},
    focusLane: (laneId) => laneService.focus(laneId).then(() => render()),
    unfocus: async () => {
      laneService.unfocus();
      render();
    },
    closeActiveLaneTerminals: () => laneService.closeActiveLaneTerminals(),
    handleTerminalOpened: () => {},
    handleTerminalClosed: (terminalId) => terminalService.handleTerminalClosed(terminalId),
    dispose: () => terminalService.dispose(),
  };
};
