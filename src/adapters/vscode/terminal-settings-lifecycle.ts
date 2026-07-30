import type { Disposable } from '../../foundation/model';
import type { TerminalSettingsLease } from './terminal-settings';

/** runtime 間で共有するターミナル設定 lifecycle */
export interface TerminalSettingsLifecycle extends Disposable {
  /**
   * runtime の設定所有開始
   * @param profileTitle - Lane Terminal の公開 title
   */
  readonly activate: (profileTitle: string) => Promise<void>;
  /** 設定所有の非同期解放 */
  readonly release: () => Promise<void>;
}

/** ターミナル設定 lifecycle の依存 */
export interface TerminalSettingsLifecycleDeps {
  /** 永続状態と設定更新を所有する単一 lease */
  readonly lease: TerminalSettingsLease;
  /**
   * 非同期終了処理の追跡開始
   * @param lifecycle - 追跡対象 lifecycle
   */
  readonly register: (lifecycle: TerminalSettingsLifecycle) => void;
  /**
   * 非同期終了処理の追跡終了
   * @param lifecycle - 追跡対象 lifecycle
   */
  readonly unregister: (lifecycle: TerminalSettingsLifecycle) => void;
  /**
   * 同期 Disposable から開始した解放失敗の通知
   * @param error - 解放失敗
   */
  readonly reportReleaseFailure: (error: unknown) => void;
}

/** runtime とターミナル設定の終了依存 */
export interface RuntimeCleanupDeps {
  /** runtime 固有 resource の同期破棄 */
  readonly disposeResources: () => void;
  /** runtime 間で共有するターミナル設定 lifecycle */
  readonly terminalSettings: TerminalSettingsLifecycle;
}

const appendFailure = (failures: unknown[], error: unknown): void => {
  if (error instanceof AggregateError) {
    failures.push(...error.errors);
    return;
  }
  failures.push(error);
};

const throwFailures = (failures: readonly unknown[], message: string): void => {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, message);
};

/**
 * runtime resource とターミナル設定解放開始の同期実行
 * @param deps - 終了依存
 */
export const disposeRuntime = (deps: RuntimeCleanupDeps): void => {
  const failures: unknown[] = [];
  try {
    deps.disposeResources();
  } catch (error) {
    appendFailure(failures, error);
  }
  try {
    deps.terminalSettings.dispose();
  } catch (error) {
    appendFailure(failures, error);
  }
  throwFailures(failures, 'Runtime disposal failed');
};

/**
 * runtime 起動失敗後の同期 resource 破棄と非同期設定復元
 * @param deps - 終了依存
 * @param startupError - runtime 起動失敗
 */
export const cleanupFailedRuntime = async (
  deps: RuntimeCleanupDeps,
  startupError: unknown,
): Promise<never> => {
  const failures: unknown[] = [startupError];
  try {
    deps.disposeResources();
  } catch (error) {
    appendFailure(failures, error);
  }
  try {
    await deps.terminalSettings.release();
  } catch (error) {
    appendFailure(failures, error);
  }
  throwFailures(failures, 'Runtime startup and cleanup failed');
  throw startupError;
};

/**
 * runtime 再試行を跨いで単一 lease を直列化する lifecycle の生成
 * @param deps - lifecycle の依存
 * @returns 直列化済み lifecycle
 */
export const createTerminalSettingsLifecycle = (
  deps: TerminalSettingsLifecycleDeps,
): TerminalSettingsLifecycle => {
  let queue = Promise.resolve();
  let lifecycle: TerminalSettingsLifecycle;

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const running = queue.then(operation, operation);
    queue = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  };

  const releaseLease = async (): Promise<void> => {
    await deps.lease.release();
    deps.unregister(lifecycle);
  };

  lifecycle = {
    activate: (profileTitle) => {
      deps.register(lifecycle);
      return enqueue(async () => {
        deps.register(lifecycle);
        try {
          await deps.lease.activate(profileTitle);
        } catch (activationError) {
          try {
            await releaseLease();
          } catch (cleanupError) {
            throw new AggregateError(
              [activationError, cleanupError],
              'Terminal settings activation and cleanup failed',
            );
          }
          throw activationError;
        }
      });
    },
    release: () => enqueue(releaseLease),
    dispose: () => {
      void lifecycle.release().catch(deps.reportReleaseFailure);
    },
  };
  return lifecycle;
};
