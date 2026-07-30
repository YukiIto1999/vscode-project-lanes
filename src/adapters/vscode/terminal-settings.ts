import type { Memento } from 'vscode';

export const TERMINAL_SETTINGS_STATE_KEY = 'projectLanes.terminalSettings';
export const LEGACY_TERMINAL_PROFILE_TITLE = 'Lane Terminal';
export const LEGACY_DEFAULT_PROFILE_KEY = 'defaultProfile.linux';
export const TERMINAL_PERSISTENCE_KEY = 'enablePersistentSessions';

type TerminalPlatformKey = 'linux' | 'osx' | 'windows';
type TerminalDefaultProfileKey =
  | 'defaultProfile.linux'
  | 'defaultProfile.osx'
  | 'defaultProfile.windows';

/** platform 別ターミナルプロファイル設定の対象 */
export interface TerminalProfileTarget {
  /** workspaceState lease の platform 識別子 */
  readonly platformKey: TerminalPlatformKey;
  /** terminal.integrated 配下の設定キー */
  readonly settingKey: TerminalDefaultProfileKey;
}

type StoredPreviousValue =
  | {
      readonly kind: 'absent';
    }
  | {
      readonly kind: 'value';
      readonly value: string | null;
    };

interface OwnedLease {
  readonly status: 'prepared' | 'owned' | 'releasing';
  readonly platformKey: TerminalPlatformKey;
  readonly previous: StoredPreviousValue;
  readonly writtenValue: string;
}

interface UserChangedLease {
  readonly status: 'user-changed';
  readonly platformKey: TerminalPlatformKey;
  readonly writtenValue: string;
}

type StoredLease = OwnedLease | UserChangedLease;
type LegacyDecision = 'scanned' | 'kept' | 'removed' | 'managed';

interface TerminalSettingsEnvelope {
  readonly schemaVersion: 1;
  readonly legacyDecision?: LegacyDecision;
  readonly leases: Partial<Record<TerminalPlatformKey, StoredLease>>;
}

/** 旧版設定に対する利用者の選択 */
export type TerminalSettingsLegacyChoice = 'keep' | 'remove' | 'manage';

/** 旧版設定の一致候補 */
export interface TerminalSettingsLegacyCandidates {
  /** Linux 既定プロファイルの一致 */
  readonly defaultProfile: boolean;
  /** 永続セッション無効化の一致 */
  readonly persistentSessions: boolean;
}

/** ターミナル設定アクセス境界 */
export interface TerminalSettingsConfiguration {
  /**
   * workspaceValue の取得
   * @param key - terminal.integrated 配下の設定キー
   * @returns workspaceValue
   */
  readonly inspectWorkspaceValue: (key: string) => unknown;
  /**
   * workspaceValue の更新
   * @param key - terminal.integrated 配下の設定キー
   * @param value - 設定値。undefined は削除
   */
  readonly updateWorkspaceValue: (key: string, value: unknown) => Promise<void>;
}

/** ターミナル設定 lease の依存 */
export interface TerminalSettingsLeaseDeps {
  /** workspace 単位の状態保存先 */
  readonly workspaceState: Memento;
  /** VS Code 設定境界 */
  readonly configuration: TerminalSettingsConfiguration;
  /** 拡張ホストの platform */
  readonly platform: NodeJS.Platform;
  /**
   * 旧版設定に対する選択
   * @param candidates - 一致した旧版設定
   * @returns 利用者の選択。dismiss は undefined
   */
  readonly chooseLegacyAction: (
    candidates: TerminalSettingsLegacyCandidates,
  ) => Promise<TerminalSettingsLegacyChoice | undefined>;
}

/** ターミナル設定 lease */
export interface TerminalSettingsLease {
  /**
   * 既定プロファイルの一時所有開始
   * @param profileTitle - Lane Terminal の公開 title
   */
  readonly activate: (profileTitle: string) => Promise<void>;
  /** 所有中の既定プロファイル復元 */
  readonly release: () => Promise<void>;
}

/**
 * Node platform から VS Code の既定ターミナル設定対象への変換
 * @param platform - Node platform
 * @returns platform 識別子と terminal.integrated 配下の設定キー
 */
export const terminalProfileTarget = (platform: NodeJS.Platform): TerminalProfileTarget => {
  if (platform === 'darwin') {
    return { platformKey: 'osx', settingKey: 'defaultProfile.osx' };
  }
  if (platform === 'win32') {
    return { platformKey: 'windows', settingKey: 'defaultProfile.windows' };
  }
  return { platformKey: 'linux', settingKey: 'defaultProfile.linux' };
};

const profileKeyForPlatform = (platform: TerminalPlatformKey): TerminalDefaultProfileKey =>
  `defaultProfile.${platform}`;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isLegacyDecision = (value: unknown): value is LegacyDecision =>
  value === 'scanned' || value === 'kept' || value === 'removed' || value === 'managed';

const isPlatformKey = (value: unknown): value is TerminalPlatformKey =>
  value === 'linux' || value === 'osx' || value === 'windows';

const isStoredPreviousValue = (value: unknown): value is StoredPreviousValue => {
  if (!isRecord(value)) return false;
  if (value.kind === 'absent') return true;
  return value.kind === 'value' && (typeof value.value === 'string' || value.value === null);
};

const isStoredLease = (value: unknown, platformKey: TerminalPlatformKey): value is StoredLease => {
  if (!isRecord(value) || value.platformKey !== platformKey) return false;
  if (typeof value.writtenValue !== 'string') return false;
  if (value.status === 'user-changed') return true;
  return (
    (value.status === 'prepared' || value.status === 'owned' || value.status === 'releasing') &&
    isStoredPreviousValue(value.previous)
  );
};

const parseEnvelope = (
  value: unknown,
):
  | { readonly kind: 'writable'; readonly value: TerminalSettingsEnvelope }
  | {
      readonly kind: 'protected';
    } => {
  if (value === undefined) {
    return {
      kind: 'writable',
      value: { schemaVersion: 1, leases: {} },
    };
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.leases)) {
    return { kind: 'protected' };
  }
  if (value.legacyDecision !== undefined && !isLegacyDecision(value.legacyDecision)) {
    return { kind: 'protected' };
  }

  const leases: Partial<Record<TerminalPlatformKey, StoredLease>> = {};
  for (const [key, lease] of Object.entries(value.leases)) {
    if (!isPlatformKey(key) || !isStoredLease(lease, key)) return { kind: 'protected' };
    leases[key] = lease;
  }
  return {
    kind: 'writable',
    value: {
      schemaVersion: 1,
      ...(value.legacyDecision === undefined
        ? {}
        : { legacyDecision: value.legacyDecision as LegacyDecision }),
      leases,
    },
  };
};

const previousFromWorkspaceValue = (value: unknown): StoredPreviousValue | undefined => {
  if (value === undefined) return { kind: 'absent' };
  if (typeof value === 'string' || value === null) return { kind: 'value', value };
  return undefined;
};

const workspaceValueForPrevious = (previous: StoredPreviousValue): string | null | undefined =>
  previous.kind === 'absent' ? undefined : previous.value;

const matchesPrevious = (value: unknown, previous: StoredPreviousValue): boolean =>
  Object.is(value, workspaceValueForPrevious(previous));

const withLease = (
  envelope: TerminalSettingsEnvelope,
  platformKey: TerminalPlatformKey,
  lease: StoredLease | undefined,
): TerminalSettingsEnvelope => {
  const leases = { ...envelope.leases };
  if (lease === undefined) {
    delete leases[platformKey];
  } else {
    leases[platformKey] = lease;
  }
  return { ...envelope, leases };
};

/**
 * workspace 設定を所有範囲だけ復元する lease の生成
 * @param deps - lease の依存
 * @returns 直列化済み lease
 */
export const createTerminalSettingsLease = (
  deps: TerminalSettingsLeaseDeps,
): TerminalSettingsLease => {
  const parsed = parseEnvelope(deps.workspaceState.get<unknown>(TERMINAL_SETTINGS_STATE_KEY));
  if (parsed.kind === 'protected') {
    return {
      activate: async () => {},
      release: async () => {},
    };
  }

  let envelope = parsed.value;
  let queue = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const running = queue.then(operation, operation);
    queue = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  };

  const persist = async (next: TerminalSettingsEnvelope): Promise<void> => {
    await deps.workspaceState.update(TERMINAL_SETTINGS_STATE_KEY, next);
    envelope = next;
  };

  const markUserChanged = async (
    platformKey: TerminalPlatformKey,
    writtenValue: string,
  ): Promise<void> => {
    await persist(
      withLease(envelope, platformKey, {
        status: 'user-changed',
        platformKey,
        writtenValue,
      }),
    );
  };

  const releasePlatform = async (platformKey: TerminalPlatformKey): Promise<void> => {
    const lease = envelope.leases[platformKey];
    if (!lease || lease.status === 'user-changed') return;
    const settingKey = profileKeyForPlatform(platformKey);
    const current = deps.configuration.inspectWorkspaceValue(settingKey);

    if (lease.status === 'prepared' && matchesPrevious(current, lease.previous)) {
      await persist(withLease(envelope, platformKey, undefined));
      return;
    }
    if (lease.status === 'releasing' && matchesPrevious(current, lease.previous)) {
      await persist(withLease(envelope, platformKey, undefined));
      return;
    }
    if (!Object.is(current, lease.writtenValue)) {
      await markUserChanged(platformKey, lease.writtenValue);
      return;
    }

    const releasing: OwnedLease = { ...lease, status: 'releasing' };
    if (lease.status !== 'releasing') {
      await persist(withLease(envelope, platformKey, releasing));
    }
    await deps.configuration.updateWorkspaceValue(
      settingKey,
      workspaceValueForPrevious(releasing.previous),
    );
    await persist(withLease(envelope, platformKey, undefined));
  };

  const acquirePlatform = async (
    platformKey: TerminalPlatformKey,
    profileTitle: string,
  ): Promise<void> => {
    const settingKey = profileKeyForPlatform(platformKey);
    let lease = envelope.leases[platformKey];
    if (lease?.status === 'user-changed') return;

    if (lease && lease.writtenValue !== profileTitle) {
      await releasePlatform(platformKey);
      lease = envelope.leases[platformKey];
      if (lease) return;
    }

    if (lease?.status === 'releasing') {
      await releasePlatform(platformKey);
      lease = envelope.leases[platformKey];
      if (lease) return;
    }

    const current = deps.configuration.inspectWorkspaceValue(settingKey);
    if (lease) {
      if (Object.is(current, lease.writtenValue)) {
        if (lease.status === 'prepared') {
          await persist(withLease(envelope, platformKey, { ...lease, status: 'owned' }));
        }
        return;
      }
      if (lease.status === 'prepared' && matchesPrevious(current, lease.previous)) {
        await deps.configuration.updateWorkspaceValue(settingKey, lease.writtenValue);
        await persist(withLease(envelope, platformKey, { ...lease, status: 'owned' }));
        return;
      }
      await markUserChanged(platformKey, lease.writtenValue);
      return;
    }

    const previous = previousFromWorkspaceValue(current);
    if (!previous) {
      await markUserChanged(platformKey, profileTitle);
      return;
    }
    const prepared: OwnedLease = {
      status: 'prepared',
      platformKey,
      previous,
      writtenValue: profileTitle,
    };
    await persist(withLease(envelope, platformKey, prepared));
    if (!Object.is(current, profileTitle)) {
      await deps.configuration.updateWorkspaceValue(settingKey, profileTitle);
    }
    await persist(withLease(envelope, platformKey, { ...prepared, status: 'owned' }));
  };

  const inspectLegacyCandidates = (): TerminalSettingsLegacyCandidates => ({
    defaultProfile:
      deps.configuration.inspectWorkspaceValue(LEGACY_DEFAULT_PROFILE_KEY) ===
      LEGACY_TERMINAL_PROFILE_TITLE,
    persistentSessions:
      deps.configuration.inspectWorkspaceValue(TERMINAL_PERSISTENCE_KEY) === false,
  });

  const migrateLegacySettings = async (): Promise<boolean> => {
    if (envelope.legacyDecision === 'kept' || envelope.legacyDecision === 'removed') return false;
    if (envelope.legacyDecision === 'scanned' || envelope.legacyDecision === 'managed') return true;

    const candidates = inspectLegacyCandidates();
    if (!candidates.defaultProfile && !candidates.persistentSessions) {
      await persist({ ...envelope, legacyDecision: 'scanned' });
      return true;
    }

    const choice = await deps.chooseLegacyAction(candidates);
    if (choice === undefined) return false;
    if (choice === 'remove') {
      if (
        candidates.defaultProfile &&
        deps.configuration.inspectWorkspaceValue(LEGACY_DEFAULT_PROFILE_KEY) ===
          LEGACY_TERMINAL_PROFILE_TITLE
      ) {
        await deps.configuration.updateWorkspaceValue(LEGACY_DEFAULT_PROFILE_KEY, undefined);
      }
      if (
        candidates.persistentSessions &&
        deps.configuration.inspectWorkspaceValue(TERMINAL_PERSISTENCE_KEY) === false
      ) {
        await deps.configuration.updateWorkspaceValue(TERMINAL_PERSISTENCE_KEY, undefined);
      }
      await persist({ ...envelope, legacyDecision: 'removed' });
      return false;
    }

    if (choice === 'manage' && candidates.defaultProfile) {
      if (
        deps.configuration.inspectWorkspaceValue(LEGACY_DEFAULT_PROFILE_KEY) ===
        LEGACY_TERMINAL_PROFILE_TITLE
      ) {
        const adopted: OwnedLease = {
          status: 'owned',
          platformKey: 'linux',
          previous: { kind: 'absent' },
          writtenValue: LEGACY_TERMINAL_PROFILE_TITLE,
        };
        await persist(withLease({ ...envelope, legacyDecision: 'managed' }, 'linux', adopted));
        return true;
      }
    }

    await persist({ ...envelope, legacyDecision: 'kept' });
    return false;
  };

  return {
    activate: (profileTitle) =>
      enqueue(async () => {
        if (!(await migrateLegacySettings())) return;
        await acquirePlatform(terminalProfileTarget(deps.platform).platformKey, profileTitle);
      }),
    release: () =>
      enqueue(async () => {
        for (const platformKey of ['linux', 'osx', 'windows'] as const) {
          await releasePlatform(platformKey);
        }
      }),
  };
};
