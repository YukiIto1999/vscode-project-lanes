import * as vscode from 'vscode';
import * as nodePath from 'node:path';
import type { AbsolutePath, Instant, LaneId, SessionId, UriString } from '../foundation/model';
import { baseName, parentDirectory, uriToAbsolutePath } from '../foundation/path';
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
import {
  bootstrapWorkspace,
  collapseFoldersToLink,
  collectLaneCandidates,
} from '../workspace/scanner';
import { createCatalogRegistry } from '../workspace/registry';
import { reconcileUserChange } from '../workspace/reconciler';
import type { WorkspaceDisabledReason } from '../workspace/model';
import { toLaneId } from '../lane/model';
import { createLaneService } from '../lane/service';
import { createLaneSessionStore } from '../lane/session-store';
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
      readonly reason: WorkspaceDisabledReason;
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

  const result = bootstrapWorkspace(workspaceHost, fileInfo, catalogStore, directory, link, toUri);
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
      const nextCount = (laneCounters.get(laneId) ?? 0) + 1;
      laneCounters.set(laneId, nextCount);
      return `${laneId}:${instanceId}:${nextCount}` as SessionId;
    },
  };

  const terminalService = createTerminalService({
    shellFactory,
    presentation,
    sessionId: sessionIdPort,
    getShellPath: () => config.read().shellPath,
  });

  const viewRebind = createLaneViewRebindAdapter(workspaceHost);

  const editorStore = createLaneSessionStore();

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
    registry,
    terminalRekey: { rekeyLane: (oldId, newId) => terminalService.rekeyLane(oldId, newId) },
    editorStore,
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
    collapseFoldersToLink(workspaceHost, action.collapsedFolder);
  });

  const addFolderCommand = vscode.commands.registerCommand('projectLanes.addFolder', async () => {
    const activeId = laneService.snapshot().activeLaneId;
    const activeLane = activeId ? registry.snapshot().byId.get(activeId) : undefined;
    const defaultDirectory = activeLane
      ? parentDirectory(activeLane.rootPath)
      : fileInfo.directoryPath;
    const picked = await prompt.pickFoldersToAdd(defaultDirectory);
    if (picked.length === 0) return;
    const existing = workspaceHost.readFolders();
    workspaceHost.applyMutation({
      start: existing.length,
      deleteCount: 0,
      folders: picked.map((uri) => ({ uri, name: baseName(uriToAbsolutePath(uri)) })),
    });
  });

  /**
   * VS Code コマンド引数からの LaneId 解決
   * @param commandArgument - VS Code が渡すコールバック第一引数
   * @returns 解決された LaneId、解決不可で undefined
   */
  const extractLaneId = (commandArgument: unknown): LaneId | undefined => {
    if (typeof commandArgument === 'string') return toLaneId(commandArgument);
    if (commandArgument && typeof commandArgument === 'object') {
      const fields = commandArgument as { laneId?: unknown; id?: unknown };
      if (typeof fields.laneId === 'string') return toLaneId(fields.laneId);
      if (typeof fields.id === 'string') return toLaneId(fields.id);
    }
    return undefined;
  };

  const renameLaneCommand = vscode.commands.registerCommand(
    'projectLanes.renameLane',
    (arg?: unknown) => laneService.renameLane(extractLaneId(arg)),
  );

  const removeLaneCommand = vscode.commands.registerCommand(
    'projectLanes.removeLane',
    (arg?: unknown) => laneService.removeLane(extractLaneId(arg)),
  );

  const reloadLanesCommand = vscode.commands.registerCommand('projectLanes.reloadLanes', () => {
    const newLanes = collectLaneCandidates(
      workspaceHost.readFolders(),
      catalogStore.load(),
      link.linkPath,
    );
    const previousActiveId = laneService.snapshot().activeLaneId;
    registry.replace(newLanes);
    laneService.initialize();
    const nextActiveId = laneService.snapshot().activeLaneId;
    if (nextActiveId && nextActiveId !== previousActiveId) {
      const lane = registry.snapshot().byId.get(nextActiveId);
      if (lane) terminalService.revealLane(lane);
    }
    render();
  });

  const switchLaneCommand = vscode.commands.registerCommand(
    'projectLanes.switchLane',
    (laneId?: string) =>
      laneService.focus(laneId === undefined ? undefined : toLaneId(laneId)).then(() => render()),
  );

  const closeTerminalsCommand = vscode.commands.registerCommand('projectLanes.closeTerminals', () =>
    laneService.closeActiveLaneTerminals(),
  );

  const toggleActivityIndicatorCommand = vscode.commands.registerCommand(
    'projectLanes.toggleActivityIndicator',
    () => config.toggleActivityIndicator(),
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
    switchLaneCommand,
    addFolderCommand,
    renameLaneCommand,
    removeLaneCommand,
    reloadLanesCommand,
    closeTerminalsCommand,
    toggleActivityIndicatorCommand,
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
