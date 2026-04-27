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
import { readLaneTerminalProfile } from '../adapters/vscode/contributions';
import { createLaneViewRebindAdapter } from '../adapters/vscode/view-rebind';
import { createTreeViewAdapter } from '../adapters/vscode/tree-view';
import { createStatusBarAdapter } from '../adapters/vscode/status-bar';
import { createPromptAdapter } from '../adapters/vscode/quick-pick';
import { createTimerAdapter } from '../adapters/vscode/timers';
import { createProcSnapshotAdapter, createProcEnvAdapter } from '../adapters/linux/procfs';
import { createClaudeSessionAdapter } from '../adapters/linux/claude-sessions';
import { createShellSessionFactory } from '../adapters/pty/node-pty';
import { createWorkspaceLinkAdapter } from '../adapters/linux/symlink';
import { bootstrapWorkspace } from '../workspace/scanner';
import { createCatalogRegistry } from '../workspace/registry';
import { reconcileUserChange } from '../workspace/reconciler';
import type { WorkspaceFolder } from '../workspace/model';
import { createLaneService } from '../lane/service';
import { createTerminalService } from '../terminal/service';
import { createAgentMonitorService } from '../agent/service';
import { createDefaultSources } from '../agent/sources/default-sources';
import { projectUi } from '../ui/projections';
import * as nodePath from 'node:path';

/** ブートストラップ結果 */
export type BootstrapOutcome =
  | {
      /** 利用可能 */
      readonly kind: 'ready';
    }
  | {
      /** 無効化 */
      readonly kind: 'disabled';
      /** 無効化理由 */
      readonly reason: 'no-workspace-file' | 'missing-anchor';
    };

/**
 * 拡張機能の組み立てと起動
 * @param context - VS Code 拡張コンテキスト
 * @returns ブートストラップ結果
 */
export const bootstrapRuntime = (context: vscode.ExtensionContext): BootstrapOutcome => {
  const workspaceHost = createWorkspaceHostAdapter();
  const workspaceFile = createWorkspaceFileAdapter();
  const directory = createDirectoryAdapter();
  const catalogStore = createCatalogStoreAdapter(context.workspaceState);
  const toUri = (path: string): UriString => vscode.Uri.file(path).toString() as UriString;

  const fileInfo = workspaceFile.read();
  if (!fileInfo) return { kind: 'disabled', reason: 'no-workspace-file' };
  const linkPath = nodePath.join(fileInfo.directoryPath, '.lanes-root', 'active') as AbsolutePath;
  const link = createWorkspaceLinkAdapter(linkPath);

  const result = bootstrapWorkspace(
    workspaceHost,
    workspaceFile,
    catalogStore,
    directory,
    link,
    toUri,
  );
  if (result.kind === 'disabled') return { kind: 'disabled', reason: result.reason };

  const { context: wsContext } = result;
  const { canonicalLanes } = wsContext;

  const registry = createCatalogRegistry(canonicalLanes, catalogStore);

  const laneProfile = readLaneTerminalProfile(context.extension);

  const settings = createWorkspaceSettingsAdapter();
  settings.setDefaultTerminalProfile(laneProfile.title);
  settings.disablePersistentTerminals();

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

  const instanceId = process.pid;
  const laneCounters = new Map<LaneId, number>();
  const sessionIdPort = {
    next: (laneId: LaneId): SessionId => {
      const n = (laneCounters.get(laneId) ?? 0) + 1;
      laneCounters.set(laneId, n);
      return `${laneId}:${instanceId}:${n}` as SessionId;
    },
  };

  const terminalService = createTerminalService({
    shellFactory,
    presentation,
    sessionId: sessionIdPort,
    getShellPath: () => config.read().shellPath,
  });

  const viewRebind = createLaneViewRebindAdapter(workspaceHost);

  const laneService = createLaneService({
    getCatalog: () => registry.snapshot(),
    workspaceKey: wsContext.key,
    editor,
    link,
    terminal: {
      revealLane: async (lane) => terminalService.revealLane(lane),
      closeLane: async (laneId) => terminalService.closeLane(laneId),
    },
    viewRebind,
    selectionStore,
    prompt,
  });
  laneService.initialize();

  const homePath = (process.env.HOME || `/home/${process.env.USER}`) as AbsolutePath;
  const agentSources = createDefaultSources(homePath, claudeSession);
  const agentMonitor = createAgentMonitorService({
    proc: procSnapshot,
    procEnv,
    clock: { nowSeconds: () => Math.floor(Date.now() / 1000) as UnixSeconds },
    sources: agentSources,
    getIdleThresholdSec: () => config.read().idleThresholdSec,
  });

  const treeView = createTreeViewAdapter();
  const statusBar = createStatusBarAdapter();

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

  const refreshAndRender = () => {
    try {
      agentMonitor.refresh(registry.snapshot(), terminalService.managedSessionIds());
    } catch {
      /* スナップショット維持 */
    }
    render();
  };

  const registryDisposable = registry.onChange(() => refreshAndRender());

  const cfg = config.read();
  let refreshDisposable = timer.every(cfg.refreshIntervalSec * 1000, refreshAndRender);

  const configDisposable = config.onDidChange((newCfg) => {
    refreshDisposable.dispose();
    refreshDisposable = timer.every(newCfg.refreshIntervalSec * 1000, refreshAndRender);
    refreshAndRender();
  });

  refreshAndRender();
  const initialLane = laneService.snapshot().activeLaneId;
  if (initialLane) {
    const lane = registry.snapshot().byId.get(initialLane);
    if (lane) terminalService.revealLane(lane);
  }

  const workspaceFoldersHandler = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    const activeId = laneService.snapshot().activeLaneId;
    const activeLane = activeId ? registry.snapshot().byId.get(activeId) : undefined;
    const action = reconcileUserChange({
      rawFolders: workspaceHost.readFolders(),
      currentLanes: registry.folders(),
      linkPath: link.linkPath,
      activeLabel: activeLane?.label ?? 'Project Lanes',
      linkUri: toUri(link.linkPath),
    });
    if (action.kind === 'noop') return;

    registry.absorb(action.additions);
    const folders = workspaceHost.readFolders();
    const collapsedFolder: WorkspaceFolder = action.collapsedFolder;
    workspaceHost.applyMutation({
      start: 0,
      deleteCount: folders.length,
      folders: [collapsedFolder],
    });
  });

  const focusCommand = vscode.commands.registerCommand('projectLanes.focus', (laneId?: string) =>
    laneService.focus(laneId as LaneId | undefined).then(() => render()),
  );

  const closeTerminalsCommand = vscode.commands.registerCommand('projectLanes.closeTerminals', () =>
    laneService.closeActiveLaneTerminals(),
  );

  const profileProvider = vscode.window.registerTerminalProfileProvider(laneProfile.id, {
    provideTerminalProfile: () => {
      const activeLaneId = laneService.snapshot().activeLaneId;
      if (!activeLaneId) return undefined;
      const lane = registry.snapshot().byId.get(activeLaneId);
      if (!lane) return undefined;
      const { sessionId, handle } = terminalService.requestSession(lane);
      return presentation.presentAsProfile(handle, lane.label, (terminalId) => {
        terminalService.bindTerminal(sessionId, terminalId);
      });
    },
  });

  const terminalCloseHandler = vscode.window.onDidCloseTerminal((terminal) => {
    const terminalId = presentation.resolveId(terminal);
    if (terminalId) {
      presentation.disposeTerminal(terminalId);
      terminalService.handleTerminalClosed(terminalId);
      refreshAndRender();
    }
  });

  context.subscriptions.push(
    focusCommand,
    closeTerminalsCommand,
    profileProvider,
    terminalCloseHandler,
    workspaceFoldersHandler,
    presentation.disposable,
    statusBar.disposable,
    ...treeView.disposables,
    configDisposable,
    registryDisposable,
    { dispose: () => refreshDisposable.dispose() },
    { dispose: () => terminalService.dispose() },
  );

  return { kind: 'ready' };
};
