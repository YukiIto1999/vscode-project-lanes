import type { Disposable } from '../foundation/model';
import type {
  WorkspaceBootstrapResult,
  WorkspaceContext,
  WorkspaceDisabledReason,
} from '../workspace/model';
import type { InitializationMode } from './model';

/** 副作用なしで判定した workspace の管理状態 */
export type InitializationClassification = 'unsupported' | 'unmanaged' | 'managed';

/** 初期化状態 */
export type InitializationStatus =
  | 'unavailable'
  | 'unmanaged'
  | 'initializing'
  | 'ready'
  | 'recoverable';

/** 初期化結果 */
export type InitializationOutcome =
  | {
      /** workspace file を利用できない */
      readonly kind: 'unavailable';
      readonly reason: 'no-workspace-file';
    }
  | {
      /** 明示初期化を待つ */
      readonly kind: 'waiting';
    }
  | {
      /** 初期化を再試行できる */
      readonly kind: 'recoverable';
      readonly reason?: WorkspaceDisabledReason;
    }
  | {
      /** runtime を利用できる */
      readonly kind: 'ready';
      readonly context: WorkspaceContext;
    };

/** 初期化 coordinator の依存 */
export interface InitializationCoordinatorDeps {
  /** 現在の管理状態を副作用なしで判定する */
  readonly inspect: () => InitializationClassification | PromiseLike<InitializationClassification>;
  /** workspace を復旧または初期化する */
  readonly initialize: () => PromiseLike<WorkspaceBootstrapResult>;
  /** 初期化済み workspace の runtime を起動する */
  readonly startRuntime: (
    context: WorkspaceContext,
  ) => void | Disposable | PromiseLike<void | Disposable>;
  /** 公開する初期化状態を更新する */
  readonly setStatus: (status: InitializationStatus) => void | PromiseLike<void>;
  /** 初期化失敗を記録して利用者へ通知する */
  readonly reportFailure: (error: unknown) => void | PromiseLike<void>;
}

/** 初期化 coordinator */
export interface InitializationCoordinator extends Disposable {
  /** activation 時の初期化方針を適用する */
  readonly activate: (
    mode: InitializationMode,
    classification: InitializationClassification,
  ) => Promise<InitializationOutcome>;
  /** 公開コマンドを含む初期化要求を一つにまとめる */
  readonly ensureReady: () => Promise<InitializationOutcome>;
}

const unavailableOutcome: InitializationOutcome = {
  kind: 'unavailable',
  reason: 'no-workspace-file',
};
const waitingOutcome: InitializationOutcome = { kind: 'waiting' };
const recoverableOutcome: InitializationOutcome = { kind: 'recoverable' };

/**
 * activation と公開コマンドの初期化処理を直列化する
 * @param deps - 状態判定、初期化、runtime 起動
 * @returns 初期化 coordinator
 */
export const createInitializationCoordinator = (
  deps: InitializationCoordinatorDeps,
): InitializationCoordinator => {
  let disposed = false;
  let inFlight: Promise<InitializationOutcome> | undefined;
  let readyOutcome: InitializationOutcome | undefined;
  let runtimeDisposable: Disposable | undefined;

  const updateStatus = async (status: InitializationStatus): Promise<void> => {
    if (disposed) return;
    await deps.setStatus(status);
  };

  const recover = async (
    error: unknown,
    reason?: WorkspaceDisabledReason,
  ): Promise<InitializationOutcome> => {
    if (disposed) return recoverableOutcome;
    await deps.reportFailure(error);
    await updateStatus('recoverable');
    return reason === undefined ? recoverableOutcome : { kind: 'recoverable', reason };
  };

  const runAttempt = async (): Promise<InitializationOutcome> => {
    try {
      const classification = await deps.inspect();
      if (classification === 'unsupported') {
        await updateStatus('unavailable');
        return unavailableOutcome;
      }

      await updateStatus('initializing');
      const result = await deps.initialize();
      if (result.kind === 'disabled') {
        await updateStatus('recoverable');
        return { kind: 'recoverable', reason: result.reason };
      }
      if (disposed) return recoverableOutcome;

      const startedRuntime = await deps.startRuntime(result.context);
      if (disposed) {
        startedRuntime?.dispose();
        return recoverableOutcome;
      }

      try {
        await updateStatus('ready');
      } catch (error) {
        startedRuntime?.dispose();
        throw error;
      }
      if (disposed) {
        startedRuntime?.dispose();
        return recoverableOutcome;
      }

      if (startedRuntime !== undefined) runtimeDisposable = startedRuntime;
      readyOutcome = { kind: 'ready', context: result.context };
      return readyOutcome;
    } catch (error) {
      return recover(error);
    }
  };

  const ensureReady = (): Promise<InitializationOutcome> => {
    if (disposed) return Promise.resolve(recoverableOutcome);
    if (readyOutcome) return Promise.resolve(readyOutcome);
    if (inFlight) return inFlight;

    const attempt = runAttempt().finally(() => {
      if (inFlight === attempt) inFlight = undefined;
    });
    inFlight = attempt;
    return attempt;
  };

  return {
    activate: async (mode, classification) => {
      if (disposed) return recoverableOutcome;
      if (classification === 'unsupported') {
        await updateStatus('unavailable');
        return unavailableOutcome;
      }
      if (classification === 'unmanaged' && mode === 'manual') {
        await updateStatus('unmanaged');
        return waitingOutcome;
      }
      return ensureReady();
    },
    ensureReady,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      runtimeDisposable?.dispose();
      runtimeDisposable = undefined;
      readyOutcome = undefined;
    },
  };
};
