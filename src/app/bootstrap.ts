import { randomUUID } from 'node:crypto';
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
  createLaneRootAvailabilityAdapter,
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
import { toLaneId, type Lane } from '../lane/model';
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
import type {
  CatalogStorePort,
  LaneIdFactoryPort,
  WorkspaceHostPort,
  WorkspaceLinkPort,
} from '../workspace/ports';
import { createWorkspaceFolderReconciler } from '../workspace/reconciler';
import { createCatalogRegistry } from '../workspace/registry';
import { bootstrapWorkspace } from '../workspace/scanner';
import { runAsyncBoundary } from './async-boundary';
import { createAsyncFailureReporter } from './async-failure-reporter';
import {
  createInitializationCoordinator,
  type InitializationClassification,
  type InitializationCoordinator,
  type InitializationOutcome,
  type InitializationStatus,
} from './initialization-coordinator';
import { laneRelocationWarningMessage } from './lane-relocation-warning';
import { resolveLaneCommandTarget } from './lane-command-target';
import { createManagedCommandProxy } from './managed-command-proxy';
import type { ConfigPort } from './model';
import {
  createRuntimeReconciler,
  isWorkspaceMutationReconciliationError,
} from './runtime-reconciliation';
import { createWorkspaceMutationFailureReporter } from './workspace-mutation-failure-reporter';
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

const reportWorkspaceMutationFailure = createWorkspaceMutationFailureReporter({
  log: (message, error) => console.error(message, error),
  notify: (message) => vscode.window.showWarningMessage(message),
});

type ManagedCommandId =
  | 'projectLanes.switchLane'
  | 'projectLanes.closeTerminals'
  | 'projectLanes.addFolder'
  | 'projectLanes.reloadLanes'
  | 'projectLanes.locateFolder'
  | 'projectLanes.renameLane'
  | 'projectLanes.removeLane'
  | 'projectLanes.findInLanes'
  | 'projectLanes.goToFileInLanes';

type ManagedCommandHandler = (args: readonly unknown[]) => unknown;
type ManagedCommandHandlers = Readonly<Record<ManagedCommandId, ManagedCommandHandler>>;

interface WorkspaceResources {
  readonly fileInfo: WorkspaceFileInfo;
  readonly link: WorkspaceLinkPort;
  readonly legacyAnchorUri: UriString;
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
  readonly laneIdFactory: LaneIdFactoryPort;
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
    laneIdFactory,
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
    const registry = createCatalogRegistry(
      workspaceContext.canonicalLanes,
      catalogStore,
      laneIdFactory,
    );
    const operationQueue = createOperationQueue();
    const laneProfile = readLaneTerminalProfile(extensionContext.extension);
    const editor = createEditorAdapter();
    const selectionStore = createSelectionStoreAdapter(extensionContext.workspaceState);
    const prompt = createPromptAdapter({
      extensionMode: extensionContext.extensionMode,
    });
    const rootAvailability = createLaneRootAvailabilityAdapter();
    const isLaneAvailable = (lane: Lane): boolean =>
      rootAvailability.inspect(lane.rootPath) === 'available';
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
        revealLane: async (lane) => {
          if (isLaneAvailable(lane)) await terminalService.revealLane(lane);
        },
        closeLane: async (laneId) => terminalService.closeLane(laneId),
      },
      viewRebind: createLaneViewRebindAdapter(workspaceHost, toUri(link.linkPath)),
      selectionStore,
      prompt,
      registry,
      editorStore: createLaneSessionStore(),
      rootAvailability,
      operationQueue,
    });
    const initialReconciliation = await laneService.reconcileActiveLane();
    if (initialReconciliation.cache === 'pending') {
      await reportAsyncFailure(initialReconciliation.error);
    }

    const laneSearchService = createLaneSearchService({
      getCatalog: () => registry.snapshot(),
      search: createRipgrepSearchAdapter(),
      ui: createSearchUiAdapter(() => registry.snapshot().lanes),
      fileOpen: editor,
      focus: (laneId) => laneService.focus(laneId),
      rootAvailability,
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
      const availabilityByLaneId = new Map(
        catalog.lanes.map((lane) => [lane.id, rootAvailability.inspect(lane.rootPath)]),
      );
      const snapshot = projectUi(
        laneService.snapshot(),
        activities,
        cfg.showActivityIndicator,
        availabilityByLaneId,
      );
      treeView.render(snapshot);
      statusBar.render(snapshot.statusBar);
    };

    const workspaceFolderReconciler = createWorkspaceFolderReconciler({
      operationQueue,
      workspaceHost,
      getCurrentLanes: () => registry.folders(),
      getActiveLabel: () => {
        const activeId = laneService.snapshot().activeLaneId;
        return (activeId && registry.snapshot().byId.get(activeId)?.label) || 'Project Lanes';
      },
      absorb: (additions) => registry.absorb(additions).then(() => undefined),
      finalizePendingOperations: () => laneService.finalizePendingOperations(),
      linkPath: link.linkPath,
      linkUri: toUri(link.linkPath),
      legacyAnchorUri: resources.legacyAnchorUri,
    });
    const runtimeReconciler = createRuntimeReconciler({
      reconcileWorkspaceFolders: () => workspaceFolderReconciler.reconcileWorkspaceFolders(),
      reconcileActiveLane: () => laneService.reconcileActiveLane(),
      getActiveLaneId: () => laneService.snapshot().activeLaneId,
      getLane: (laneId) => registry.snapshot().byId.get(laneId),
      isLaneAvailable,
      revealLane: async (lane) => terminalService.revealLane(lane),
      render,
      reportPendingCache: reportAsyncFailure,
      reportWorkspaceMutationRejected: (error) =>
        reportWorkspaceMutationFailure(
          'Project Lanes workspace folder reconciliation failed.',
          error ?? new Error('workspace-folder-mutation-rejected'),
        ),
    });

    track(laneActivity.onChange(render));
    track(registry.onChange(render));
    track(config.onDidChange(() => render()));

    render();
    const initialLane = laneService.snapshot().activeLaneId;
    if (initialLane) {
      const lane = registry.snapshot().byId.get(initialLane);
      if (lane && isLaneAvailable(lane)) terminalService.revealLane(lane);
    }

    track(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void runAsyncBoundary(() => runtimeReconciler.reconcile(), reportAsyncFailure);
      }),
    );

    track(
      vscode.window.registerTerminalProfileProvider(laneProfile.id, {
        provideTerminalProfile: () => {
          const activeLaneId = laneService.snapshot().activeLaneId;
          if (!activeLaneId) return undefined;
          const lane = registry.snapshot().byId.get(activeLaneId);
          if (!lane || !isLaneAvailable(lane)) return undefined;
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
        runAsyncBoundary(
          () => laneService.renameLane(resolveLaneCommandTarget(argument, registry.snapshot())),
          reportAsyncFailure,
        ),
      'projectLanes.locateFolder': ([argument]) =>
        runAsyncBoundary(async () => {
          const result = await laneService.relocateLane(
            resolveLaneCommandTarget(argument, registry.snapshot()),
          );
          render();
          const message = laneRelocationWarningMessage(result);
          if (message) await vscode.window.showWarningMessage(message);
        }, reportAsyncFailure),
      'projectLanes.removeLane': ([argument]) =>
        runAsyncBoundary(
          () => laneService.removeLane(resolveLaneCommandTarget(argument, registry.snapshot())),
          reportAsyncFailure,
        ),
      'projectLanes.reloadLanes': () =>
        runAsyncBoundary(() => runtimeReconciler.reconcile(), reportAsyncFailure),
      'projectLanes.switchLane': ([argument]) =>
        runAsyncBoundary(async () => {
          const result = await laneService.focus(
            resolveLaneCommandTarget(argument, registry.snapshot()),
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
  const laneIdFactory: LaneIdFactoryPort = { next: () => toLaneId(randomUUID()) };
  const laneProfile = readLaneTerminalProfile(context.extension);
  const toUri = (path: string): UriString => vscode.Uri.file(path).toString() as UriString;
  let initializedResources: WorkspaceResources | undefined;
  let runtimeCommands: ManagedCommandHandlers | undefined;
  let workspaceStatus: InitializationStatus = 'unavailable';
  let coordinator: InitializationCoordinator;

  const readResources = (): WorkspaceResources | undefined => {
    const fileInfo = workspaceFile.read();
    if (!fileInfo) return undefined;
    const legacyAnchorPath = nodePath.join(fileInfo.directoryPath, '.lanes-root') as AbsolutePath;
    const linkPath = nodePath.join(legacyAnchorPath, 'active') as AbsolutePath;
    return {
      fileInfo,
      link: createWorkspaceLinkAdapter(linkPath),
      legacyAnchorUri: toUri(legacyAnchorPath),
    };
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
        resources.legacyAnchorUri,
        resources.link,
        laneIdFactory,
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
        laneIdFactory,
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
      if (isWorkspaceMutationReconciliationError(error)) {
        await reportWorkspaceMutationFailure('Project Lanes initialization failed.', error);
        return;
      }
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
  const locateFolderCommand = vscode.commands.registerCommand(
    'projectLanes.locateFolder',
    (...args: unknown[]) => invokeManagedCommand('projectLanes.locateFolder', args),
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
    locateFolderCommand,
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
