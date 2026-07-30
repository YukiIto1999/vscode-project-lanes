import { describe, expect, it, vi } from 'vitest';
import type { Memento } from 'vscode';
import {
  createTerminalSettingsLease,
  terminalProfileTarget,
  type TerminalSettingsConfiguration,
  type TerminalSettingsLegacyChoice,
} from './terminal-settings';

const STATE_KEY = 'projectLanes.terminalSettings';
const PROFILE_TITLE = 'Lane Terminal';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

interface HarnessOptions {
  readonly state?: unknown;
  readonly values?: Readonly<Record<string, unknown>>;
  readonly platform?: NodeJS.Platform;
  readonly choice?: TerminalSettingsLegacyChoice | undefined;
  readonly updateState?: Memento['update'];
  readonly updateConfiguration?: TerminalSettingsConfiguration['updateWorkspaceValue'];
}

const createHarness = (options: HarnessOptions = {}) => {
  let state = options.state;
  const values = new Map(Object.entries(options.values ?? {}));
  const stateWrites: unknown[] = [];
  const configurationWrites: Array<readonly [string, unknown]> = [];
  const prompt = vi.fn(async () => options.choice);
  const memento: Memento = {
    get: <T>(key: string) => (key === STATE_KEY ? (state as T) : undefined),
    update: async (key, value) => {
      stateWrites.push(value);
      if (options.updateState) {
        await options.updateState(key, value);
      }
      state = value;
    },
    keys: () => [],
  };
  const configuration: TerminalSettingsConfiguration = {
    inspectWorkspaceValue: (key) => values.get(key),
    updateWorkspaceValue: async (key, value) => {
      configurationWrites.push([key, value]);
      if (options.updateConfiguration) {
        await options.updateConfiguration(key, value);
      }
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    },
  };
  const lease = createTerminalSettingsLease({
    workspaceState: memento,
    configuration,
    platform: options.platform ?? 'linux',
    chooseLegacyAction: prompt,
  });
  return {
    lease,
    values,
    stateWrites,
    configurationWrites,
    prompt,
    readState: () => state,
  };
};

describe('terminalProfileTarget', () => {
  it.each([
    ['darwin', { platformKey: 'osx', settingKey: 'defaultProfile.osx' }],
    ['win32', { platformKey: 'windows', settingKey: 'defaultProfile.windows' }],
    ['linux', { platformKey: 'linux', settingKey: 'defaultProfile.linux' }],
    ['freebsd', { platformKey: 'linux', settingKey: 'defaultProfile.linux' }],
  ] as const)('%s を %s へ対応付ける', (platform, expected) => {
    expect(terminalProfileTarget(platform)).toEqual(expected);
  });
});

describe('createTerminalSettingsLease', () => {
  it.each([
    ['壊れた state', { schemaVersion: 1, legacyDecision: 'invalid' }],
    ['将来 schema', { schemaVersion: 2, legacyDecision: 'scanned', leases: {} }],
  ])('%s を保護して設定と state を変更しない', async (_label, state) => {
    const harness = createHarness({ state });

    await harness.lease.activate(PROFILE_TITLE);
    await harness.lease.release();

    expect(harness.configurationWrites).toEqual([]);
    expect(harness.stateWrites).toEqual([]);
    expect(harness.prompt).not.toHaveBeenCalled();
  });

  it.each([
    ['未設定', {}, undefined],
    ['null', { 'defaultProfile.linux': null }, null],
  ])('%s の workspaceValue を取得前の値へ戻す', async (_label, values, previous) => {
    const harness = createHarness({
      state: { schemaVersion: 1, legacyDecision: 'scanned', leases: {} },
      values,
    });

    await harness.lease.activate(PROFILE_TITLE);
    expect(harness.values.get('defaultProfile.linux')).toBe(PROFILE_TITLE);
    await harness.lease.release();

    expect(harness.values.get('defaultProfile.linux')).toBe(previous);
    expect(harness.readState()).toEqual({
      schemaVersion: 1,
      legacyDecision: 'scanned',
      leases: {},
    });
  });

  it('prepared を先に保存し、設定成功後に owned として保存する', async () => {
    const harness = createHarness({
      state: { schemaVersion: 1, legacyDecision: 'scanned', leases: {} },
      values: { 'defaultProfile.linux': 'bash' },
    });

    await harness.lease.activate(PROFILE_TITLE);

    expect(harness.stateWrites).toEqual([
      {
        schemaVersion: 1,
        legacyDecision: 'scanned',
        leases: {
          linux: {
            status: 'prepared',
            platformKey: 'linux',
            previous: { kind: 'value', value: 'bash' },
            writtenValue: PROFILE_TITLE,
          },
        },
      },
      {
        schemaVersion: 1,
        legacyDecision: 'scanned',
        leases: {
          linux: {
            status: 'owned',
            platformKey: 'linux',
            previous: { kind: 'value', value: 'bash' },
            writtenValue: PROFILE_TITLE,
          },
        },
      },
    ]);
    expect(harness.configurationWrites).toEqual([['defaultProfile.linux', PROFILE_TITLE]]);
  });

  it('設定失敗後は prepared を残し、次の activate で再試行する', async () => {
    const failure = new Error('configuration write failed');
    let writeCount = 0;
    const harness = createHarness({
      state: { schemaVersion: 1, legacyDecision: 'scanned', leases: {} },
      values: { 'defaultProfile.linux': 'bash' },
      updateConfiguration: async () => {
        writeCount += 1;
        if (writeCount === 1) throw failure;
      },
    });

    await expect(harness.lease.activate(PROFILE_TITLE)).rejects.toBe(failure);
    expect(harness.readState()).toMatchObject({
      leases: { linux: { status: 'prepared' } },
    });

    await harness.lease.activate(PROFILE_TITLE);

    expect(harness.configurationWrites).toEqual([
      ['defaultProfile.linux', PROFILE_TITLE],
      ['defaultProfile.linux', PROFILE_TITLE],
    ]);
    expect(harness.readState()).toMatchObject({
      leases: { linux: { status: 'owned' } },
    });
  });

  it('prepared の設定反映後に state 保存だけ失敗しても次回 owned へ移行する', async () => {
    let stateWriteCount = 0;
    const failure = new Error('owned state write failed');
    const harness = createHarness({
      state: { schemaVersion: 1, legacyDecision: 'scanned', leases: {} },
      values: { 'defaultProfile.linux': 'bash' },
      updateState: async (_key, value) => {
        stateWriteCount += 1;
        if (
          stateWriteCount === 2 &&
          (value as { leases?: { linux?: { status?: string } } }).leases?.linux?.status === 'owned'
        ) {
          throw failure;
        }
      },
    });

    await expect(harness.lease.activate(PROFILE_TITLE)).rejects.toBe(failure);
    expect(harness.values.get('defaultProfile.linux')).toBe(PROFILE_TITLE);
    expect(harness.readState()).toMatchObject({
      leases: { linux: { status: 'prepared' } },
    });

    await harness.lease.activate(PROFILE_TITLE);

    expect(harness.configurationWrites).toEqual([['defaultProfile.linux', PROFILE_TITLE]]);
    expect(harness.readState()).toMatchObject({
      leases: { linux: { status: 'owned' } },
    });
  });

  it('owned 設定を利用者が変えた場合は tombstone を残して上書きしない', async () => {
    const state = {
      schemaVersion: 1,
      legacyDecision: 'scanned',
      leases: {
        linux: {
          status: 'owned',
          platformKey: 'linux',
          previous: { kind: 'value', value: 'bash' },
          writtenValue: PROFILE_TITLE,
        },
      },
    };
    const harness = createHarness({
      state,
      values: { 'defaultProfile.linux': 'zsh' },
    });

    await harness.lease.activate(PROFILE_TITLE);
    await harness.lease.release();

    expect(harness.values.get('defaultProfile.linux')).toBe('zsh');
    expect(harness.configurationWrites).toEqual([]);
    expect(harness.readState()).toMatchObject({
      leases: { linux: { status: 'user-changed' } },
    });
  });

  it('release 直前の利用者変更を保持して tombstone を残す', async () => {
    const harness = createHarness({
      state: { schemaVersion: 1, legacyDecision: 'scanned', leases: {} },
      values: { 'defaultProfile.linux': 'bash' },
    });
    await harness.lease.activate(PROFILE_TITLE);
    harness.values.set('defaultProfile.linux', 'fish');

    await harness.lease.release();

    expect(harness.values.get('defaultProfile.linux')).toBe('fish');
    expect(harness.configurationWrites).toEqual([['defaultProfile.linux', PROFILE_TITLE]]);
    expect(harness.readState()).toMatchObject({
      leases: { linux: { status: 'user-changed' } },
    });
  });

  it('復元失敗後は releasing を残し、次の release で再試行する', async () => {
    const failure = new Error('restore failed');
    let writeCount = 0;
    const harness = createHarness({
      state: { schemaVersion: 1, legacyDecision: 'scanned', leases: {} },
      values: { 'defaultProfile.linux': 'bash' },
      updateConfiguration: async (_key, value) => {
        writeCount += 1;
        if (value === 'bash' && writeCount === 2) throw failure;
      },
    });
    await harness.lease.activate(PROFILE_TITLE);

    await expect(harness.lease.release()).rejects.toBe(failure);
    expect(harness.readState()).toMatchObject({
      leases: { linux: { status: 'releasing' } },
    });

    await harness.lease.release();

    expect(harness.values.get('defaultProfile.linux')).toBe('bash');
    expect(harness.readState()).toEqual({
      schemaVersion: 1,
      legacyDecision: 'scanned',
      leases: {},
    });
  });

  it('state 確定失敗後も復元済みの値を認識して release を完了する', async () => {
    const failure = new Error('release state write failed');
    let failed = false;
    const harness = createHarness({
      state: { schemaVersion: 1, legacyDecision: 'scanned', leases: {} },
      values: { 'defaultProfile.linux': 'bash' },
      updateState: async (_key, value) => {
        const lease = (value as { leases?: { linux?: { status?: string } } }).leases?.linux;
        if (
          !failed &&
          lease === undefined &&
          harness.values.get('defaultProfile.linux') === 'bash'
        ) {
          failed = true;
          throw failure;
        }
      },
    });
    await harness.lease.activate(PROFILE_TITLE);

    await expect(harness.lease.release()).rejects.toBe(failure);
    expect(harness.readState()).toMatchObject({
      leases: { linux: { status: 'releasing' } },
    });

    await harness.lease.release();

    expect(harness.configurationWrites).toEqual([
      ['defaultProfile.linux', PROFILE_TITLE],
      ['defaultProfile.linux', 'bash'],
    ]);
    expect(harness.readState()).toEqual({
      schemaVersion: 1,
      legacyDecision: 'scanned',
      leases: {},
    });
  });

  it('並行 activate と release の設定書込を呼出順に直列化する', async () => {
    const first = deferred();
    const started = deferred();
    const harness = createHarness({
      state: { schemaVersion: 1, legacyDecision: 'scanned', leases: {} },
      values: { 'defaultProfile.linux': 'bash' },
      updateConfiguration: async (_key, value) => {
        if (value === PROFILE_TITLE) {
          started.resolve();
          await first.promise;
        }
      },
    });

    const activation = harness.lease.activate(PROFILE_TITLE);
    const release = harness.lease.release();
    await started.promise;
    expect(harness.configurationWrites).toEqual([['defaultProfile.linux', PROFILE_TITLE]]);

    first.resolve();
    await Promise.all([activation, release]);

    expect(harness.configurationWrites).toEqual([
      ['defaultProfile.linux', PROFILE_TITLE],
      ['defaultProfile.linux', 'bash'],
    ]);
  });

  it('legacy 候補を keep した場合は削除も当該 activate の lease 取得もしない', async () => {
    const harness = createHarness({
      values: {
        'defaultProfile.linux': PROFILE_TITLE,
        enablePersistentSessions: false,
      },
      choice: 'keep',
    });

    await harness.lease.activate(PROFILE_TITLE);

    expect(harness.prompt).toHaveBeenCalledOnce();
    expect(harness.configurationWrites).toEqual([]);
    expect(harness.readState()).toEqual({
      schemaVersion: 1,
      legacyDecision: 'kept',
      leases: {},
    });
  });

  it('legacy prompt の dismiss は決定を保存せず、次の managed activate で再表示する', async () => {
    const harness = createHarness({
      values: {
        'defaultProfile.linux': PROFILE_TITLE,
        enablePersistentSessions: false,
      },
      choice: undefined,
    });

    await harness.lease.activate(PROFILE_TITLE);
    await harness.lease.activate(PROFILE_TITLE);

    expect(harness.prompt).toHaveBeenCalledTimes(2);
    expect(harness.configurationWrites).toEqual([]);
    expect(harness.stateWrites).toEqual([]);
    expect(harness.readState()).toBeUndefined();
  });

  it('legacy 候補の remove は一致値だけを削除し、自動 lease を永続的に抑止する', async () => {
    let updateCount = 0;
    const harness = createHarness({
      platform: 'darwin',
      values: {
        'defaultProfile.linux': PROFILE_TITLE,
        'defaultProfile.osx': 'zsh',
        enablePersistentSessions: false,
      },
      choice: 'remove',
      updateConfiguration: async () => {
        updateCount += 1;
        if (updateCount === 1) harness.values.set('enablePersistentSessions', true);
      },
    });

    await harness.lease.activate(PROFILE_TITLE);

    expect(harness.configurationWrites).toEqual([['defaultProfile.linux', undefined]]);
    expect(harness.values.get('defaultProfile.linux')).toBeUndefined();
    expect(harness.values.get('enablePersistentSessions')).toBe(true);
    expect(harness.values.get('defaultProfile.osx')).toBe('zsh');
    expect(harness.readState()).toEqual({
      schemaVersion: 1,
      legacyDecision: 'removed',
      leases: {},
    });

    await harness.lease.activate(PROFILE_TITLE);
    expect(harness.configurationWrites).toEqual([['defaultProfile.linux', undefined]]);
  });

  it.each(['kept', 'removed'] as const)(
    'legacy decision %s は再 prompt と自動 lease を抑止する',
    async (legacyDecision) => {
      const harness = createHarness({
        platform: 'win32',
        state: { schemaVersion: 1, legacyDecision, leases: {} },
        values: { 'defaultProfile.windows': 'PowerShell' },
      });

      await harness.lease.activate(PROFILE_TITLE);

      expect(harness.prompt).not.toHaveBeenCalled();
      expect(harness.configurationWrites).toEqual([]);
    },
  );

  it('Manage Lane Terminal は exact な legacy profile を previous=absent の lease として採用する', async () => {
    const harness = createHarness({
      values: {
        'defaultProfile.linux': PROFILE_TITLE,
        enablePersistentSessions: false,
      },
      choice: 'manage',
    });

    await harness.lease.activate(PROFILE_TITLE);

    expect(harness.configurationWrites).toEqual([]);
    expect(harness.readState()).toEqual({
      schemaVersion: 1,
      legacyDecision: 'managed',
      leases: {
        linux: {
          status: 'owned',
          platformKey: 'linux',
          previous: { kind: 'absent' },
          writtenValue: PROFILE_TITLE,
        },
      },
    });

    await harness.lease.release();

    expect(harness.configurationWrites).toEqual([['defaultProfile.linux', undefined]]);
    expect(harness.values.get('enablePersistentSessions')).toBe(false);
  });

  it('managed decision は次回以降も reversible lease を許可する', async () => {
    const harness = createHarness({
      platform: 'win32',
      state: { schemaVersion: 1, legacyDecision: 'managed', leases: {} },
      values: { 'defaultProfile.windows': 'PowerShell' },
    });

    await harness.lease.activate(PROFILE_TITLE);

    expect(harness.prompt).not.toHaveBeenCalled();
    expect(harness.configurationWrites).toEqual([['defaultProfile.windows', PROFILE_TITLE]]);
  });

  it('legacy 候補がなければ判定済み state と platform lease を直列に保存する', async () => {
    const harness = createHarness({
      values: {
        'defaultProfile.linux': 'bash',
        enablePersistentSessions: true,
      },
    });

    await harness.lease.activate(PROFILE_TITLE);

    expect(harness.prompt).not.toHaveBeenCalled();
    expect(harness.readState()).toMatchObject({
      schemaVersion: 1,
      legacyDecision: 'scanned',
      leases: { linux: { status: 'owned' } },
    });
    expect(harness.configurationWrites).toEqual([['defaultProfile.linux', PROFILE_TITLE]]);
  });
});
