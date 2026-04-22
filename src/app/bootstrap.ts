import * as vscode from 'vscode';
import type { AbsolutePath, LaneId, SessionId, UnixSeconds, UriString } from '../foundation/model';
import { createConfigAdapter } from '../adapters/vscode/config';
import { createCatalogStoreAdapter, createSelectionStoreAdapter } from '../adapters/vscode/storage';
import { createEditorAdapter } from '../adapters/vscode/editors';
import {
  createDirectoryAdapter,
  createWorkspaceFileAdapter,
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
import { createCatalogRegistry } from '../workspace/registry';
import { reconcileUserChange } from '../workspace/reconciler';
import { planFocusLane, planRevealAll } from '../workspace/folder-plan';
import type { FolderMutation } from '../workspace/model';
import type { WorkspaceHostPort } from '../workspace/ports';
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
  const rawWorkspaceHost = createWorkspaceHostAdapter();
  const workspaceFile = createWorkspaceFileAdapter();
  const directory = createDirectoryAdapter();
  const catalogStore = createCatalogStoreAdapter(context.workspaceState);
  const toUri = (path: string): UriString => vscode.Uri.file(path).toString() as UriString;

  // 自変更の識別カウンタ: applyMutation で++、onDidChangeWorkspaceFolders で--
  let selfMutations = 0;
  const workspaceHost: WorkspaceHostPort = {
    readFolders: rawWorkspaceHost.readFolders,
    applyMutation: (m: FolderMutation) => {
      selfMutations++;
      rawWorkspaceHost.applyMutation(m);
    },
  };

  const result = bootstrapWorkspace(workspaceHost, workspaceFile, catalogStore, directory, toUri);
  if (result.kind === 'disabled') return undefined;

  const { context: wsContext } = result;
  const { anchor, canonicalLanes } = wsContext;

  // カタログ集約（実行時の可変）
  const registry = createCatalogRegistry(canonicalLanes, catalogStore);

  // ワークスペース設定（既存設定をマージ / 冪等）
  const settings = createWorkspaceSettingsAdapter();
  settings.hideAnchor(anchor);
  settings.setDefaultTerminalProfile('projectLanes.terminal');
  settings.disablePersistentTerminals();

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
    getCatalog: () => registry.snapshot(),
    workspaceKey: wsContext.key,
    editor,
    visibility: {
      focusLane: (lane) => {
        const folders = workspaceHost.readFolders();
        workspaceHost.applyMutation(planFocusLane(folders.length, lane));
      },
      revealAllLanes: () => {
        const folders = workspaceHost.readFolders();
        workspaceHost.applyMutation(planRevealAll(folders.length, registry.snapshot()));
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
      agentMonitor.refresh(registry.snapshot(), terminalService.managedSessionIds());
    } catch {
      // /proc 読み取りエラー等は無視して前回のスナップショットを維持
    }
    render();
  };

  // カタログ変化時に再描画
  const registryDisposable = registry.onChange(() => refreshAndRender());

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
    const lane = registry.snapshot().byId.get(initialLane);
    if (lane) terminalService.revealLane(lane);
  }

  render();

  // ワークスペースフォルダ変化の購読
  // 自変更（applyMutation 経由）は selfMutations カウンタでスキップし、
  // ユーザー操作（Add/Remove Folder to Workspace）のみを reconcile する
  const workspaceFoldersHandler = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (selfMutations > 0) {
      selfMutations--;
      return;
    }
    const action = reconcileUserChange({
      rawFolders: workspaceHost.readFolders(),
      currentLanes: registry.folders(),
      activeLaneId: laneService.snapshot().activeLaneId,
    });

    if (action.kind === 'noop') return;

    if (action.kind === 'replace') {
      registry.replace(action.canonicalLanes);
      return;
    }

    // absorb: カタログに追記 → focused 状態を再適用（追加フォルダを workspaceFolders から除去）
    registry.absorb(action.additions);
    const activeLane = registry.snapshot().byId.get(action.restoreFocusLaneId);
    if (activeLane) {
      const folders = workspaceHost.readFolders();
      workspaceHost.applyMutation(planFocusLane(folders.length, activeLane));
    }
  });

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
      const lane = registry.snapshot().byId.get(activeLaneId);
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
    workspaceFoldersHandler,
    statusBar.disposable,
    ...treeView.disposables,
    configDisposable,
    registryDisposable,
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
