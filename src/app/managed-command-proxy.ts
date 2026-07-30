import type { InitializationOutcome, InitializationStatus } from './initialization-coordinator';

/** managed runtime の公開 command handler */
export type ManagedCommandProxyHandler = (args: readonly unknown[]) => unknown;

/** managed command proxy の依存 */
export interface ManagedCommandProxyDeps<CommandId extends string> {
  /** runtime handler の取得 */
  readonly getHandler: (command: CommandId) => ManagedCommandProxyHandler | undefined;
  /** workspace 状態の取得 */
  readonly getStatus: () => InitializationStatus;
  /** workspace file 不在時の案内 */
  readonly showUnavailable: () => void | PromiseLike<void>;
  /** 明示初期化の確認 */
  readonly confirmInitialization: () => boolean | PromiseLike<boolean>;
  /** workspace 初期化 */
  readonly initialize: () => PromiseLike<InitializationOutcome>;
}

/** managed command proxy */
export type ManagedCommandProxy<CommandId extends string> = (
  command: CommandId,
  args: readonly unknown[],
) => Promise<unknown>;

/**
 * managed runtime の状態に応じて公開 command を転送
 * @param deps - runtime handler、初期化、利用者案内
 * @returns command proxy
 */
export const createManagedCommandProxy = <CommandId extends string>(
  deps: ManagedCommandProxyDeps<CommandId>,
): ManagedCommandProxy<CommandId> => {
  return async (command, args) => {
    const readyHandler = deps.getHandler(command);
    if (readyHandler) return readyHandler(args);

    const status = deps.getStatus();
    if (status === 'unavailable') {
      await deps.showUnavailable();
      return undefined;
    }

    if (status !== 'initializing' && !(await deps.confirmInitialization())) {
      return undefined;
    }

    const outcome = await deps.initialize();
    if (outcome.kind !== 'ready') return undefined;
    return deps.getHandler(command)?.(args);
  };
};
