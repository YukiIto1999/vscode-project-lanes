import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import { createWorkspaceLinkAdapter } from '../adapters/linux/symlink';
import { createShellSessionFactory } from '../adapters/pty/node-pty';
import { createRipgrepSearchAdapter } from '../adapters/search/ripgrep';
import { createConfigAdapter } from '../adapters/vscode/config';
import { readLaneTerminalProfile } from '../adapters/vscode/contributions';
import { createEditorAdapter } from '../adapters/vscode/editors';
import { createPromptAdapter } from '../adapters/vscode/prompt';
import { createSearchUiAdapter } from '../adapters/vscode/search-pick';
import { createStatusBarAdapter } from '../adapters/vscode/status-bar';
import { createCatalogStoreAdapter, createSelectionStoreAdapter } from '../adapters/vscode/storage';
import { createTerminalPresentationAdapter } from '../adapters/vscode/terminals';
import { createTreeViewAdapter } from '../adapters/vscode/tree-view';
import { createLaneViewRebindAdapter } from '../adapters/vscode/view-rebind';
import {
  createDirectoryAdapter,
  createWorkspaceFileAdapter,
  createWorkspaceHostAdapter,
  createWorkspaceSettingsAdapter,
} from '../adapters/vscode/workspace';
import type {
  AbsolutePath,
  Disposable,
  Instant,
  LaneId,
  SessionId,
  UriString,
} from '../foundation/model';
import { createOperationQueue } from '../foundation/operation-queue';
import { baseName, parentDirectory, uriToAbsolutePath } from '../foundation/path';
import { projectLaneActivities } from '../lane-activity/reducer';
import type { MonotonicClockPort } from '../lane-activity/ports';
import { createLaneActivityService } from '../lane-activity/service';
import { toLaneId } from '../lane/model';
import { createLaneService } from '../lane/service';
import { createLaneSessionStore } from '../lane/session-store';
import { createLaneSearchService } from '../search/service';
import type { SessionIdPort } from '../terminal/ports';
import { createTerminalService } from '../terminal/service';
import { projectUi } from '../ui/projections';
import { inspectWorkspace } from '../workspace/inspection';
import type {
  WorkspaceContext,
  WorkspaceDisabledReason,
  WorkspaceFileInfo,
} from '../workspace/model';
import type { CatalogStorePort, WorkspaceHostPort, WorkspaceLinkPort } from '../workspace/ports';
import { reconcileUserChange } from '../workspace/reconciler';
import { createCatalogRegistry } from '../workspace/registry';
import { bootstrapWorkspace, collapseFoldersToLink } from '../workspace/scanner';
import { runAsyncBoundary } from './async-boundary';
import { createAsyncFailureReporter } from './async-failure-reporter';
import {
  createInitializationCoordinator,
  type InitializationClassification,
  type InitializationCoordinator,
  type InitializationOutcome,
  type InitializationStatus,
} from './initialization-coordinator';
import { createManagedCommandProxy } from './managed-command-proxy';
import type { ConfigPort } from './model';
import { workspaceWarningMessage } from './workspace-warning';

const INITIALIZE_ACTION = 'Initialize Workspace';
const INITIALIZATION_GUIDANCE =
  'Project Lanes: Initialize this workspace before using lane commands.';
const WORKSPACE_FILE_GUIDANCE =
  'Project Lanes: Open a .code-workspace file before using lane commands.';
const MISSING_LANE_GUIDANCE =
  'Project Lanes: Add at least one folder to the workspace before initializing it.';
const OPERATION_FAILURE_MESSAGE =
  'Project Lanes operation failed. See the Developer Tools console for details.';

type ManagedCommandId =
  | 'projectLanes.switchLane'
  | 'projectLanes.closeTerminals'
  | 'projectLanes.addFolder'
  | 'projectLanes.reloadLanes'
  | 'projectLanes.renameLane'
  | 'projectLanes.removeLane'
  | 'projectLanes.findInLanes'
  | 'projectLanes.goToFileInLanes';

type ManagedCommandHandler = (args: readonly unknown[]) => unknown;
type ManagedCommandHandlers = Readonly<Record<ManagedCommandId, ManagedCommandHandler>>;

interface WorkspaceResources {
  readonly fileInfo: WorkspaceFileInfo;
  readonly link: WorkspaceLinkPort;
}

interface ManagedRuntime {
  readonly commands: ManagedCommandHandlers;
  readonly disposable: Disposable;
}

interface ManagedRuntimeDeps {
  readonly extensionContext: vscode.ExtensionContext;
  readonly workspaceContext: WorkspaceContext;
  readonly workspaceHost: WorkspaceHostPort;
  readonly resources: WorkspaceResources;
  readonly catalogStore: CatalogStorePort;
  readonly config: ConfigPort;
  readonly toUri: (path: string) => UriString;
}

/** ブートストラップ結果 */
export type BootstrapOutcome =
  | {
      /** 利用可能 */
      readonly kind: 'ready';
    }
  | {
      /** 明示初期化待ち */
      readonly kind: 'waiting';
    }
  | {
      /** workspace file を利用できない */
      readonly kind: 'unavailable';
      readonly reason: 'no-workspace-file';
    }
  | {
      /** 再試行可能 */
      readonly kind: 'recoverable';
      readonly reason?: WorkspaceDisabledReason;
    };

/**
 * レーン別連番に基づくセッション ID 採番ポートの生成
 * @param instanceId - プロセス単位の識別子
 * @returns セッション ID 採番ポート
 */
const createSessionIdSequencer = (instanceId: number): SessionIdPort => {
  const laneCounters = new Map<LaneId, number>();
  return {
    next: (laneId) => {
      const nextCount = (laneCounters.get(laneId) ?? 0) + 1;
      laneCounters.set(laneId, nextCount);
      return `${laneId}:${instanceId}:${nextCount}` as SessionId;
    },
  };
};

/**
 * VS Code コマンド引数からの LaneId 解決
 * @param commandArgument - VS Code が渡すコールバック第一引数
 * @returns 解決された LaneId、または undefined
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

/**
 * 初期化結果から公開結果への変換
 * @param outcome - coordinator の初期化結果
 * @returns activation の公開結果
 */
const toBootstrapOutcome = (outcome: InitializationOutcome): BootstrapOutcome => {
  switch (outcome.kind) {
    case 'ready':
      return { kind: 'ready' };
    case 'waiting':
      return { kind: 'waiting' };
    case 'unavailable':
      return { kind: 'unavailable', reason: outcome.reason };
    case 'recoverable':
      return outcome.reason === undefined
        ? { kind: 'recoverable' }
        : { kind: 'recoverable', reason: outcome.reason };
  }
};

/**
 * 初期化結果に対応する案内の表示
 * @param outcome - coordinator の初期化結果
 */
const reportInitializationOutcome = async (outcome: InitializationOutcome): Promise<void> => {
  if (outcome.kind === 'unavailable') {
    await vscode.window.showInformationMessage(WORKSPACE_FILE_GUIDANCE);
    return;
  }
  if (outcome.kind !== 'recoverable' || outcome.reason === undefined) return;
  if (outcome.reason === 'missing-lane-source') {
    await vscode.window.showWarningMessage(MISSING_LANE_GUIDANCE);
    return;
  }
  const message = workspaceWarningMessage(outcome.reason);
  if (message) await vscode.window.showWarningMessage(message);
};

/**
 * 管理済み workspace の runtime 構築
 * @param deps - runtime の依存
 * @returns コマンド実装と破棄処理
 */
const createManagedRuntime = async (deps: ManagedRuntimeDeps): Promise<ManagedRuntime> => {
  const {
    extensionContext,
    workspaceContext,
    workspaceHost,
    resources,
    catalogStore,
    config,
    toUri,
  } = deps;
  const { fileInfo, link } = resources;
  const disposables: Disposable[] = [];
  const track = <T extends Disposable>(disposable: T): T => {
    disposables.push(disposable);
    return disposable;
  };
  const dispose = (): void => {
    for (const disposable of disposables.splice(0).reverse()) disposable.dispose();
  };

  try {
    const registry = createCatalogRegistry(workspaceContext.canonicalLanes, catalogStore);
    const operationQueue = createOperationQueue();
    const laneProfile = readLaneTerminalProfile(extensionContext.extension);
    const editor = createEditorAdapter();
    const selectionStore = createSelectionStoreAdapter(extensionContext.workspaceState);
    const prompt = createPromptAdapter();
    const extensionPath = extensionContext.extensionPath as AbsolutePath;
    const clock: MonotonicClockPort = { now: () => Date.now() as Instant };
    const laneActivity = createLaneActivityService({ clock });
    track({ dispose: () => laneActivity.dispose() });

    const shellFactory = createShellSessionFactory({
      extensionPath,
      activitySink: laneActivity.sink,
    });
    const presentation = createTerminalPresentationAdapter({ activitySink: laneActivity.sink });
    track(presentation.disposable);

    const terminalService = createTerminalService({
      shellFactory,
      presentation,
      sessionId: createSessionIdSequencer(process.pid),
      getShellPath: () => config.read().shellPath,
    });
    track({ dispose: () => terminalService.dispose() });

    const reportAsyncFailure = createAsyncFailureReporter({
      log: (message, error) => console.error(message, error),
      notify: () => vscode.window.showErrorMessage(OPERATION_FAILURE_MESSAGE),
    });
    const laneService = createLaneService({
      getCatalog: () => registry.snapshot(),
      workspaceKey: workspaceContext.key,
      editor,
      link,
      terminal: {
        revealLane: async (lane) => terminalService.revealLane(lane),
        closeLane: async (laneId) => terminalService.closeLane(laneId),
      },
      viewRebind: createLaneViewRebindAdapter(workspaceHost, toUri(link.linkPath)),
      selectionStore,
      prompt,
      registry,
      terminalRekey: { rekeyLane: (oldId, newId) => terminalService.rekeyLane(oldId, newId) },
      editorStore: createLaneSessionStore(),
      operationQueue,
    });
    const initialReconciliation = await laneService.reconcileActiveLane();
    if (initialReconciliation.kind === 'active' && initialReconciliation.cache === 'pending') {
      await reportAsyncFailure(initialReconciliation.error);
    }

    const laneSearchService = createLaneSearchService({
      getCatalog: () => registry.snapshot(),
      search: createRipgrepSearchAdapter(),
      ui: createSearchUiAdapter(),
      fileOpen: editor,
      focus: (laneId) => laneService.focus(laneId),
    });

    const treeView = createTreeViewAdapter();
    treeView.disposables.forEach(track);
    const statusBar = createStatusBarAdapter();
    track(statusBar.disposable);

    const render = (): void => {
      const cfg = config.read();
      const catalog = registry.snapshot();
      const activities = projectLaneActivities(
        laneActivity.snapshot(),
        terminalService,
        catalog.lanes.map((lane) => lane.id),
        clock.now(),
      );
      const snapshot = projectUi(laneService.snapshot(), activities, cfg.showActivityIndicator);
      treeView.render(snapshot);
      statusBar.render(snapshot.statusBar);
    };

    track(laneActivity.onChange(render));
    track(registry.onChange(render));
    track(config.onDidChange(() => render()));

    render();
    const initialLane = laneService.snapshot().activeLaneId;
    if (initialLane) {
      const lane = registry.snapshot().byId.get(initialLane);
      if (lane) terminalService.revealLane(lane);
    }

    track(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void runAsyncBoundary(
          () =>
            operationQueue.enqueue(async () => {
              await laneService.finalizePendingOperations();
              const activeId = laneService.snapshot().activeLaneId;
              const activeLane = activeId ? registry.snapshot().byId.get(activeId) : undefined;
              const rawFolders = workspaceHost.readFolders();
              const action = reconcileUserChange({
                rawFolders,
                currentLanes: registry.folders(),
                linkPath: link.linkPath,
                activeLabel: activeLane?.label ?? 'Project Lanes',
                linkUri: toUri(link.linkPath),
              });
              if (action.kind === 'noop') return;

              await registry.absorb(action.additions);
              await collapseFoldersToLink(workspaceHost, rawFolders, action.collapsedFolder);
            }),
          reportAsyncFailure,
        );
      }),
    );

    track(
      vscode.window.registerTerminalProfileProvider(laneProfile.id, {
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
      }),
    );

    track(
      vscode.window.onDidCloseTerminal((terminal) => {
        const terminalId = presentation.resolveId(terminal);
        if (!terminalId) return;
        presentation.disposeTerminal(terminalId);
        terminalService.handleTerminalClosed(terminalId);
        render();
      }),
    );

    const commands: ManagedCommandHandlers = {
      'projectLanes.addFolder': async () => {
        const activeId = laneService.snapshot().activeLaneId;
        const activeLane = activeId ? registry.snapshot().byId.get(activeId) : undefined;
        const defaultDirectory = activeLane
          ? parentDirectory(activeLane.rootPath)
          : fileInfo.directoryPath;
        const picked = await prompt.pickFoldersToAdd(defaultDirectory);
        if (picked.length === 0) return;
        const existing = workspaceHost.readFolders();
        const accepted = await workspaceHost.applyMutation({
          expectedFolders: existing,
          start: existing.length,
          deleteCount: 0,
          folders: picked.map((uri) => ({ uri, name: baseName(uriToAbsolutePath(uri)) })),
        });
        if (!accepted) prompt.warnAddFolderFailed();
      },
      'projectLanes.renameLane': ([argument]) =>
        runAsyncBoundary(() => laneService.renameLane(extractLaneId(argument)), reportAsyncFailure),
      'projectLanes.removeLane': ([argument]) =>
        runAsyncBoundary(() => laneService.removeLane(extractLaneId(argument)), reportAsyncFailure),
      'projectLanes.reloadLanes': () =>
        runAsyncBoundary(async () => {
          const previousActiveId = laneService.snapshot().activeLaneId;
          try {
            const reconciliation = await laneService.reconcileActiveLane();
            if (reconciliation.kind === 'active' && reconciliation.cache === 'pending') {
              await reportAsyncFailure(reconciliation.error);
            }
          } finally {
            const nextActiveId = laneService.snapshot().activeLaneId;
            if (nextActiveId && nextActiveId !== previousActiveId) {
              const lane = registry.snapshot().byId.get(nextActiveId);
              if (lane) terminalService.revealLane(lane);
            }
            render();
          }
        }, reportAsyncFailure),
      'projectLanes.switchLane': ([laneId]) =>
        runAsyncBoundary(async () => {
          const result = await laneService.focus(
            typeof laneId === 'string' ? toLaneId(laneId) : undefined,
          );
          render();
          if (result.kind === 'failed') throw result.error;
        }, reportAsyncFailure),
      'projectLanes.closeTerminals': () => laneService.closeActiveLaneTerminals(),
      'projectLanes.findInLanes': () =>
        runAsyncBoundary(() => laneSearchService.findInLanes(), reportAsyncFailure),
      'projectLanes.goToFileInLanes': () =>
        runAsyncBoundary(() => laneSearchService.goToFileInLanes(), reportAsyncFailure),
    };

    return { commands, disposable: { dispose } };
  } catch (error) {
    dispose();
    throw error;
  }
};

/**
 * 拡張機能の組み立てと起動
 * @param context - VS Code 拡張コンテキスト
 * @returns ブートストラップ結果
 */
export const bootstrapRuntime = async (
  context: vscode.ExtensionContext,
): Promise<BootstrapOutcome> => {
  const config = createConfigAdapter();
  const workspaceHost = createWorkspaceHostAdapter();
  const workspaceFile = createWorkspaceFileAdapter();
  const directory = createDirectoryAdapter();
  const settings = createWorkspaceSettingsAdapter();
  const catalogStore = createCatalogStoreAdapter(context.workspaceState);
  const laneProfile = readLaneTerminalProfile(context.extension);
  const toUri = (path: string): UriString => vscode.Uri.file(path).toString() as UriString;
  let initializedResources: WorkspaceResources | undefined;
  let runtimeCommands: ManagedCommandHandlers | undefined;
  let workspaceStatus: InitializationStatus = 'unavailable';
  let coordinator: InitializationCoordinator;

  const readResources = (): WorkspaceResources | undefined => {
    const fileInfo = workspaceFile.read();
    if (!fileInfo) return undefined;
    const linkPath = nodePath.join(fileInfo.directoryPath, '.lanes-root', 'active') as AbsolutePath;
    return { fileInfo, link: createWorkspaceLinkAdapter(linkPath) };
  };

  const inspect = (): InitializationClassification => {
    const resources = readResources();
    if (!resources) return 'unsupported';
    return inspectWorkspace({
      workspaceFile,
      workspaceHost,
      catalogStore,
      link: resources.link,
    }).kind;
  };

  coordinator = createInitializationCoordinator({
    inspect,
    initialize: async () => {
      initializedResources = undefined;
      const resources = readResources();
      if (!resources) return { kind: 'disabled', reason: 'no-workspace-file' };

      const result = await bootstrapWorkspace(
        workspaceHost,
        resources.fileInfo,
        catalogStore,
        directory,
        resources.link,
        toUri,
      );
      if (result.kind === 'disabled') return result;

      await settings.setDefaultTerminalProfile(laneProfile.title);
      await settings.disablePersistentTerminals();
      initializedResources = resources;
      return result;
    },
    startRuntime: async (workspaceContext) => {
      const resources = initializedResources;
      if (!resources) throw new Error('Project Lanes initialization resources are unavailable.');

      const runtime = await createManagedRuntime({
        extensionContext: context,
        workspaceContext,
        workspaceHost,
        resources,
        catalogStore,
        config,
        toUri,
      });
      runtimeCommands = runtime.commands;
      return {
        dispose: () => {
          if (runtimeCommands === runtime.commands) runtimeCommands = undefined;
          runtime.disposable.dispose();
        },
      };
    },
    setStatus: async (status) => {
      workspaceStatus = status;
      await vscode.commands.executeCommand('setContext', 'projectLanes.workspaceStatus', status);
    },
    reportFailure: async (error) => {
      console.error('Project Lanes initialization failed.', error);
      await vscode.window.showErrorMessage(OPERATION_FAILURE_MESSAGE);
    },
  });

  const initializeWorkspace = async (): Promise<InitializationOutcome> => {
    const outcome = await coordinator.ensureReady();
    await reportInitializationOutcome(outcome);
    return outcome;
  };

  const invokeManagedCommand = createManagedCommandProxy<ManagedCommandId>({
    getHandler: (command) => runtimeCommands?.[command],
    getStatus: () => workspaceStatus,
    showUnavailable: async () => {
      await vscode.window.showInformationMessage(WORKSPACE_FILE_GUIDANCE);
    },
    confirmInitialization: async () => {
      const selection = await vscode.window.showInformationMessage(
        INITIALIZATION_GUIDANCE,
        INITIALIZE_ACTION,
      );
      return selection === INITIALIZE_ACTION;
    },
    initialize: initializeWorkspace,
  });

  const initializeWorkspaceCommand = vscode.commands.registerCommand(
    'projectLanes.initializeWorkspace',
    () => initializeWorkspace(),
  );
  const switchLaneCommand = vscode.commands.registerCommand(
    'projectLanes.switchLane',
    (...args: unknown[]) => invokeManagedCommand('projectLanes.switchLane', args),
  );
  const closeTerminalsCommand = vscode.commands.registerCommand(
    'projectLanes.closeTerminals',
    (...args: unknown[]) => invokeManagedCommand('projectLanes.closeTerminals', args),
  );
  const addFolderCommand = vscode.commands.registerCommand(
    'projectLanes.addFolder',
    (...args: unknown[]) => invokeManagedCommand('projectLanes.addFolder', args),
  );
  const reloadLanesCommand = vscode.commands.registerCommand(
    'projectLanes.reloadLanes',
    (...args: unknown[]) => invokeManagedCommand('projectLanes.reloadLanes', args),
  );
  const renameLaneCommand = vscode.commands.registerCommand(
    'projectLanes.renameLane',
    (...args: unknown[]) => invokeManagedCommand('projectLanes.renameLane', args),
  );
  const removeLaneCommand = vscode.commands.registerCommand(
    'projectLanes.removeLane',
    (...args: unknown[]) => invokeManagedCommand('projectLanes.removeLane', args),
  );
  const toggleActivityIndicatorCommand = vscode.commands.registerCommand(
    'projectLanes.toggleActivityIndicator',
    () => config.toggleActivityIndicator(),
  );
  const findInLanesCommand = vscode.commands.registerCommand(
    'projectLanes.findInLanes',
    (...args: unknown[]) => invokeManagedCommand('projectLanes.findInLanes', args),
  );
  const goToFileInLanesCommand = vscode.commands.registerCommand(
    'projectLanes.goToFileInLanes',
    (...args: unknown[]) => invokeManagedCommand('projectLanes.goToFileInLanes', args),
  );

  context.subscriptions.push(
    initializeWorkspaceCommand,
    switchLaneCommand,
    closeTerminalsCommand,
    addFolderCommand,
    reloadLanesCommand,
    renameLaneCommand,
    removeLaneCommand,
    toggleActivityIndicatorCommand,
    findInLanesCommand,
    goToFileInLanesCommand,
    coordinator,
  );

  const classification = inspect();
  const outcome = await coordinator.activate(config.read().initializationMode, classification);
  return toBootstrapOutcome(outcome);
};
