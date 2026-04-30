import * as vscode from 'vscode';
import * as nodePath from 'node:path';
import type { AbsolutePath, Instant, LaneId, SessionId, UriString } from '../foundation/model';
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
import { createShellSessionFactory } from '../adapters/pty/node-pty';
import { createWorkspaceLinkAdapter } from '../adapters/linux/symlink';
import { bootstrapWorkspace } from '../workspace/scanner';
import { createCatalogRegistry } from '../workspace/registry';
import { reconcileUserChange } from '../workspace/reconciler';
import type { WorkspaceFolder } from '../workspace/model';
import { createLaneService } from '../lane/service';
import { createTerminalService } from '../terminal/service';
import { createLaneActivityService } from '../lane-activity/service';
import { projectLaneActivities } from '../lane-activity/reducer';
import type { MonotonicClockPort } from '../lane-activity/ports';
import { projectUi } from '../ui/projections';

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
  const extensionPath = context.extensionPath as AbsolutePath;

  const clock: MonotonicClockPort = { now: () => Date.now() as Instant };
  const laneActivity = createLaneActivityService({ clock });

  const shellFactory = createShellSessionFactory({
    extensionPath,
    activitySink: laneActivity.sink,
  });
  const presentation = createTerminalPresentationAdapter({ activitySink: laneActivity.sink });

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

  const treeView = createTreeViewAdapter();
  const statusBar = createStatusBarAdapter();

  const render = (): void => {
    const cfg = config.read();
    const catalog = registry.snapshot();
    const activities = projectLaneActivities(
      laneActivity.snapshot(),
      terminalService,
      catalog.lanes.map((l) => l.id),
      clock.now(),
    );
    const snapshot = projectUi(laneService.snapshot(), activities, cfg.showActivityIndicator);
    treeView.render(snapshot);
    statusBar.render(snapshot.statusBar);
  };

  const activityDisposable = laneActivity.onChange(render);
  const registryDisposable = registry.onChange(render);
  const configDisposable = config.onDidChange(() => render());

  render();
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
    if (!terminalId) return;
    presentation.disposeTerminal(terminalId);
    terminalService.handleTerminalClosed(terminalId);
    render();
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
    activityDisposable,
    { dispose: () => laneActivity.dispose() },
    { dispose: () => terminalService.dispose() },
  );

  return { kind: 'ready' };
};
