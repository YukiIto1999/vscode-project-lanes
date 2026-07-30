import { describe, expect, it, vi } from 'vitest';
import { runAsyncBoundary } from '../app/async-boundary';
import type {
  AbsolutePath,
  Disposable,
  LaneId,
  SessionId,
  TerminalId,
  UriString,
} from '../foundation/model';
import type { Lane } from '../lane/model';
import type {
  ShellSessionFactoryPort,
  ShellSessionHandle,
  TerminalPresentationPort,
} from './ports';
import { createTerminalService } from './service';

const makeLane = (label: string, id = 'lane-a'): Lane => ({
  id: id as LaneId,
  label,
  rootUri: `file:///projects/${id}` as UriString,
  rootPath: `/projects/${id}` as AbsolutePath,
});

interface TestHandle extends ShellSessionHandle {
  readonly emitExit: () => void;
  readonly exitListenerCount: () => number;
  readonly kill: ReturnType<typeof vi.fn>;
}

const makeHandle = (id: SessionId, exitOnSubscribe = false): TestHandle => {
  const exitListeners: (() => void)[] = [];
  return {
    id,
    write: vi.fn(),
    resize: vi.fn(),
    attachOutput: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: (listener): Disposable => {
      if (exitOnSubscribe) {
        listener();
        return { dispose: () => {} };
      }
      exitListeners.push(listener);
      return {
        dispose: () => {
          const index = exitListeners.indexOf(listener);
          if (index >= 0) exitListeners.splice(index, 1);
        },
      };
    },
    kill: vi.fn(),
    exitListenerCount: () => exitListeners.length,
    emitExit: () => {
      const listeners = exitListeners.splice(0);
      for (const listener of listeners) listener();
    },
  };
};

const createHarness = ({ exitOnSubscribe = false } = {}) => {
  const handles: TestHandle[] = [];
  let exitSynchronously = exitOnSubscribe;
  const shellFactory: ShellSessionFactoryPort = {
    create: (spec) => {
      const handle = makeHandle(spec.id, exitSynchronously);
      handles.push(handle);
      return handle;
    },
  };

  let terminalCounter = 0;
  let onDisposeAll: (terminalId: TerminalId) => void = () => {};
  let onDisposeTerminal: (terminalId: TerminalId) => void = () => {};
  const attached = new Map<TerminalId, ShellSessionHandle>();
  const attachedTitles = new Map<TerminalId, string>();
  const attachImplementation: TerminalPresentationPort['attachSession'] = (handle, title) => {
    const terminalId = `terminal-${++terminalCounter}` as TerminalId;
    attached.set(terminalId, handle);
    attachedTitles.set(terminalId, title);
    return terminalId;
  };
  const attachSession = vi.fn<TerminalPresentationPort['attachSession']>(attachImplementation);
  const showTerminal = vi.fn<TerminalPresentationPort['showTerminal']>();
  const disposeTerminal = vi.fn<TerminalPresentationPort['disposeTerminal']>((terminalId) => {
    attached.delete(terminalId);
    attachedTitles.delete(terminalId);
    onDisposeTerminal(terminalId);
  });
  const disposeAllOwned = vi.fn<TerminalPresentationPort['disposeAllOwned']>(() => {
    const terminalIds = [...attached.keys()];
    attached.clear();
    for (const terminalId of terminalIds) onDisposeAll(terminalId);
    return terminalIds;
  });
  const presentation: TerminalPresentationPort = {
    attachSession,
    showTerminal,
    disposeTerminal,
    forgetTerminal: vi.fn(),
    disposeAllOwned,
  };

  let sessionCounter = 0;
  const service = createTerminalService({
    shellFactory,
    presentation,
    sessionId: {
      next: () => `session-${++sessionCounter}` as SessionId,
    },
    getShellPath: () => undefined,
  });

  return {
    service,
    handles,
    attachSession,
    showTerminal,
    disposeTerminal,
    attached,
    attachedTitles,
    attachImplementation,
    setExitOnSubscribe: (value: boolean) => {
      exitSynchronously = value;
    },
    setOnDisposeAll: (listener: (terminalId: TerminalId) => void) => {
      onDisposeAll = listener;
    },
    setOnDisposeTerminal: (listener: (terminalId: TerminalId) => void) => {
      onDisposeTerminal = listener;
    },
  };
};

const addBoundSession = (
  h: ReturnType<typeof createHarness>,
  lane: Lane,
): { readonly sessionId: SessionId; readonly terminalId: TerminalId } => {
  const requested = h.service.requestSession(lane);
  const terminalId = h.attachSession(requested.handle, lane.label);
  h.service.bindTerminal(requested.sessionId, terminalId);
  return { sessionId: requested.sessionId, terminalId };
};

describe('createTerminalService', () => {
  it('PTY の自然終了時は kill せず状態を除去し、次回表示で新規セッションを開始する', () => {
    const h = createHarness();
    const lane = makeLane('Lane A');
    h.service.revealLane(lane);
    const firstTerminalId = [...h.attached.keys()][0]!;

    h.handles[0]!.emitExit();
    h.service.handleTerminalClosed(firstTerminalId);

    expect(h.handles[0]!.kill).not.toHaveBeenCalled();
    expect(h.handles[0]!.exitListenerCount()).toBe(0);
    expect(h.service.resolveLaneBySession('session-1' as SessionId)).toBeUndefined();

    h.service.revealLane(lane);

    expect(h.handles).toHaveLength(2);
    expect(h.attachSession).toHaveBeenLastCalledWith(h.handles[1], 'Lane A');
  });

  it('終了済み PTY の onExit が同期通知しても表示面を生成しない', () => {
    const h = createHarness({ exitOnSubscribe: true });

    h.service.revealLane(makeLane('Lane A'));

    expect(h.attachSession).not.toHaveBeenCalled();
    expect(h.handles[0]!.kill).not.toHaveBeenCalled();
    expect(h.service.resolveLaneBySession('session-1' as SessionId)).toBeUndefined();
  });

  it('利用者が Terminal を閉じた場合は対応セッションを状態から除去して kill する', () => {
    const h = createHarness();
    h.service.revealLane(makeLane('Lane A'));
    const terminalId = [...h.attached.keys()][0]!;

    h.service.handleTerminalClosed(terminalId);

    expect(h.handles[0]!.kill).toHaveBeenCalledOnce();
    expect(h.service.resolveLaneBySession('session-1' as SessionId)).toBeUndefined();
  });

  it('レーン切替による表示面破棄の close 通知では既存セッションを kill しない', () => {
    const h = createHarness();
    h.service.revealLane(makeLane('Lane A'));
    h.setOnDisposeAll((terminalId) => h.service.handleTerminalClosed(terminalId));

    h.service.revealLane(makeLane('Lane B', 'lane-b'));

    expect(h.handles[0]!.kill).not.toHaveBeenCalled();
    expect(h.service.resolveLaneBySession('session-1' as SessionId)).toBe('lane-a');
  });

  it('非アクティブレーンは次回表示時に現在の label で既存セッションを接続する', () => {
    const h = createHarness();
    h.service.revealLane(makeLane('Old name'));
    h.service.revealLane(makeLane('Other', 'lane-b'));
    h.attachSession.mockClear();

    h.service.revealLane(makeLane('New name'));

    expect(h.attachSession).toHaveBeenCalledWith(h.handles[0], 'New name');
  });

  it('アクティブレーンの rename は同じセッションを focus を奪わない新しい表示面へ接続する', () => {
    const h = createHarness();
    h.service.revealLane(makeLane('Old name'));
    const oldTerminalId = [...h.attached.keys()][0]!;
    h.attachSession.mockClear();
    h.showTerminal.mockClear();

    h.service.refreshLane(makeLane('New name'));

    expect(h.disposeTerminal).toHaveBeenCalledWith(oldTerminalId);
    expect(h.attachSession).toHaveBeenCalledWith(h.handles[0], 'New name');
    const replacementId = h.attachSession.mock.results[0]!.value;
    expect(h.showTerminal).toHaveBeenCalledWith(replacementId, true);
    expect(h.handles[0]!.kill).not.toHaveBeenCalled();
  });

  it('可視 session の自然終了後に rename すると残存末尾 session を表示する', () => {
    const h = createHarness();
    const lane = makeLane('Old name');
    h.service.revealLane(lane);
    addBoundSession(h, lane);
    h.handles[1]!.emitExit();
    h.attachSession.mockClear();
    h.showTerminal.mockClear();

    h.service.refreshLane(makeLane('New name'));

    expect(h.attachSession).toHaveBeenCalledOnce();
    expect(h.attachSession).toHaveBeenCalledWith(h.handles[0], 'New name');
    const replacementId = h.attachSession.mock.results[0]!.value;
    expect(h.showTerminal).toHaveBeenCalledWith(replacementId, true);
  });

  it('rename 中の dispose 失敗は同じ表示面の破棄から再開する', () => {
    const h = createHarness();
    const lane = makeLane('Old name');
    h.service.revealLane(lane);
    const oldTerminalId = [...h.attached.keys()][0]!;
    const failure = new Error('dispose failed');
    h.disposeTerminal.mockImplementationOnce(() => {
      throw failure;
    });
    h.attachSession.mockClear();

    expect(() => h.service.refreshLane(makeLane('New name'))).toThrow(failure);
    expect(h.attachSession).not.toHaveBeenCalled();

    h.service.refreshLane(makeLane('New name'));

    expect(h.disposeTerminal).toHaveBeenCalledTimes(2);
    expect(h.disposeTerminal).toHaveBeenNthCalledWith(1, oldTerminalId);
    expect(h.disposeTerminal).toHaveBeenNthCalledWith(2, oldTerminalId);
    expect(h.attachSession).toHaveBeenCalledOnce();
    expect([...h.attachedTitles.values()]).toEqual(['New name']);
  });

  it('rename 中の attach 失敗は破棄済み表示面を再破棄せず接続から再開する', () => {
    const h = createHarness();
    h.service.revealLane(makeLane('Old name'));
    const failure = new Error('attach failed');
    h.disposeTerminal.mockClear();
    h.attachSession.mockClear();
    h.attachSession.mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => h.service.refreshLane(makeLane('New name'))).toThrow(failure);

    h.service.refreshLane(makeLane('New name'));

    expect(h.disposeTerminal).toHaveBeenCalledOnce();
    expect(h.attachSession).toHaveBeenCalledTimes(2);
    expect([...h.attachedTitles.values()]).toEqual(['New name']);
  });

  it('rename 中の preserve-focus 表示失敗は同じ表示面の表示から再開する', () => {
    const h = createHarness();
    h.service.revealLane(makeLane('Old name'));
    const failure = new Error('show failed');
    h.showTerminal.mockClear();
    h.showTerminal.mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => h.service.refreshLane(makeLane('New name'))).toThrow(failure);
    const replacementId = h.attachSession.mock.results.at(-1)!.value;

    h.service.finalizePendingPresentations();

    expect(h.showTerminal).toHaveBeenCalledTimes(2);
    expect(h.showTerminal).toHaveBeenNthCalledWith(1, replacementId, true);
    expect(h.showTerminal).toHaveBeenNthCalledWith(2, replacementId, true);
    expect([...h.attachedTitles.values()]).toEqual(['New name']);
  });

  it('複数セッション途中の attach 失敗は完了済みセッションを再生成しない', () => {
    const h = createHarness();
    const oldLane = makeLane('Old name');
    h.service.revealLane(oldLane);
    const second = addBoundSession(h, oldLane);
    const failure = new Error('second attach failed');
    h.disposeTerminal.mockClear();
    h.attachSession.mockClear();
    h.attachSession.mockImplementationOnce(h.attachImplementation).mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => h.service.refreshLane(makeLane('New name'))).toThrow(failure);

    h.service.refreshLane(makeLane('New name'));

    expect(h.attachSession.mock.calls.filter(([handle]) => handle === h.handles[0])).toHaveLength(
      1,
    );
    expect(h.attachSession.mock.calls.filter(([handle]) => handle === h.handles[1])).toHaveLength(
      2,
    );
    expect(h.disposeTerminal).toHaveBeenCalledTimes(2);
    expect(h.disposeTerminal).toHaveBeenCalledWith(second.terminalId);
    expect([...h.attachedTitles.values()]).toEqual(['New name', 'New name']);
  });

  it('可視 session の pending attach 中の自然終了は残存 session へ表示責務を移す', () => {
    const h = createHarness();
    const lane = makeLane('Old name');
    h.service.revealLane(lane);
    addBoundSession(h, lane);
    const failure = new Error('visible attach failed');
    h.attachSession.mockClear();
    h.showTerminal.mockClear();
    h.attachSession.mockImplementationOnce(h.attachImplementation).mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => h.service.refreshLane(makeLane('New name'))).toThrow(failure);
    const remainingTerminalId = h.attachSession.mock.results[0]!.value;
    h.handles[1]!.emitExit();

    h.service.finalizePendingPresentations();

    expect(h.showTerminal).toHaveBeenCalledOnce();
    expect(h.showTerminal).toHaveBeenCalledWith(remainingTerminalId, true);
    expect([...h.attachedTitles.values()]).toContain('New name');
  });

  it('旧 label で生成待ちの profile は bind 時に最新 label の表示面へ置換して表示する', () => {
    const h = createHarness();
    const requested = h.service.requestSession(makeLane('Old name'));
    h.service.refreshLane(makeLane('New name'));
    const oldTerminalId = h.attachSession(requested.handle, requested.profileTitle);
    h.setOnDisposeTerminal((terminalId) => h.service.handleTerminalClosed(terminalId));
    h.attachSession.mockClear();
    h.showTerminal.mockClear();

    h.service.bindTerminal(requested.sessionId, oldTerminalId);

    expect(h.disposeTerminal).toHaveBeenCalledWith(oldTerminalId);
    expect(h.attachSession).toHaveBeenCalledOnce();
    expect(h.attachSession).toHaveBeenCalledWith(requested.handle, 'New name');
    const replacementId = h.attachSession.mock.results[0]!.value;
    expect(h.showTerminal).toHaveBeenCalledWith(replacementId, false);
    expect([...h.attachedTitles.values()]).toEqual(['New name']);
    expect(h.handles[0]!.kill).not.toHaveBeenCalled();
    expect(h.service.resolveLaneBySession(requested.sessionId)).toBe('lane-a');
  });

  it('profile 置換の dispose 失敗は共通 pending finalization から再開する', () => {
    const h = createHarness();
    const requested = h.service.requestSession(makeLane('Old name'));
    h.service.refreshLane(makeLane('New name'));
    const oldTerminalId = h.attachSession(requested.handle, requested.profileTitle);
    const failure = new Error('dispose failed');
    h.disposeTerminal.mockImplementationOnce(() => {
      throw failure;
    });
    h.attachSession.mockClear();

    expect(() => h.service.bindTerminal(requested.sessionId, oldTerminalId)).toThrow(failure);

    h.service.finalizePendingPresentations();

    expect(h.disposeTerminal).toHaveBeenCalledTimes(2);
    expect(h.attachSession).toHaveBeenCalledOnce();
    expect(h.showTerminal).toHaveBeenCalledOnce();
    expect([...h.attachedTitles.values()]).toEqual(['New name']);
  });

  it('profile 置換の attach 失敗は共通 pending finalization から再開する', () => {
    const h = createHarness();
    const requested = h.service.requestSession(makeLane('Old name'));
    h.service.refreshLane(makeLane('New name'));
    const oldTerminalId = h.attachSession(requested.handle, requested.profileTitle);
    const failure = new Error('attach failed');
    h.attachSession.mockClear();
    h.attachSession.mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => h.service.bindTerminal(requested.sessionId, oldTerminalId)).toThrow(failure);

    h.service.finalizePendingPresentations();

    expect(h.disposeTerminal).toHaveBeenCalledOnce();
    expect(h.attachSession).toHaveBeenCalledTimes(2);
    expect(h.showTerminal).toHaveBeenCalledOnce();
    expect([...h.attachedTitles.values()]).toEqual(['New name']);
  });

  it('profile 置換の show 失敗は一度だけ通知し共通 pending finalization から再開する', async () => {
    const h = createHarness();
    const requested = h.service.requestSession(makeLane('Old name'));
    h.service.refreshLane(makeLane('New name'));
    const oldTerminalId = h.attachSession(requested.handle, requested.profileTitle);
    const failure = new Error('show failed');
    const report = vi.fn();
    h.showTerminal.mockImplementationOnce(() => {
      throw failure;
    });
    h.attachSession.mockClear();

    await runAsyncBoundary(
      async () => h.service.bindTerminal(requested.sessionId, oldTerminalId),
      report,
    );
    h.service.finalizePendingPresentations();

    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(failure);
    expect(h.disposeTerminal).toHaveBeenCalledOnce();
    expect(h.attachSession).toHaveBeenCalledOnce();
    expect(h.showTerminal).toHaveBeenCalledTimes(2);
    expect([...h.attachedTitles.values()]).toEqual(['New name']);
  });

  it('attach 失敗中の profile 置換は別 label へ再構成して最新表示面だけを表示する', () => {
    const h = createHarness();
    const requested = h.service.requestSession(makeLane('Old name'));
    h.service.refreshLane(makeLane('First name'));
    const oldTerminalId = h.attachSession(requested.handle, requested.profileTitle);
    const failure = new Error('attach failed');
    h.attachSession.mockClear();
    h.attachSession.mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => h.service.bindTerminal(requested.sessionId, oldTerminalId)).toThrow(failure);

    h.service.refreshLane(makeLane('Newest name'));
    h.service.finalizePendingPresentations();

    expect(h.disposeTerminal).toHaveBeenCalledOnce();
    expect(h.attachSession).toHaveBeenCalledTimes(2);
    expect(h.attachSession).toHaveBeenLastCalledWith(requested.handle, 'Newest name');
    expect(h.showTerminal).toHaveBeenCalledOnce();
    expect([...h.attachedTitles.values()]).toEqual(['Newest name']);
  });

  it('正常な reveal で再構築した lane は obsolete な pending 表示更新を再実行しない', () => {
    const h = createHarness();
    const requested = h.service.requestSession(makeLane('Old name'));
    h.service.refreshLane(makeLane('New name'));
    const oldTerminalId = h.attachSession(requested.handle, requested.profileTitle);
    const failure = new Error('attach failed');
    h.attachSession.mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => h.service.bindTerminal(requested.sessionId, oldTerminalId)).toThrow(failure);
    h.attachSession.mockClear();

    h.service.revealLane(makeLane('New name'));
    h.service.finalizePendingPresentations();

    expect(h.attachSession).toHaveBeenCalledOnce();
    expect(h.showTerminal).toHaveBeenCalledOnce();
    expect([...h.attachedTitles.values()]).toEqual(['New name']);
  });

  it('別 lane の正常な reveal は inactive lane の obsolete な pending 表示更新も破棄する', () => {
    const h = createHarness();
    const requested = h.service.requestSession(makeLane('Old name'));
    h.service.refreshLane(makeLane('New name'));
    const oldTerminalId = h.attachSession(requested.handle, requested.profileTitle);
    const failure = new Error('attach failed');
    h.attachSession.mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => h.service.bindTerminal(requested.sessionId, oldTerminalId)).toThrow(failure);

    h.service.revealLane(makeLane('Lane B', 'lane-b'));
    h.attachSession.mockClear();
    h.showTerminal.mockClear();

    h.service.finalizePendingPresentations();

    expect(h.attachSession).not.toHaveBeenCalled();
    expect(h.showTerminal).not.toHaveBeenCalled();
    expect([...h.attachedTitles.values()]).toEqual(['Lane B']);
  });

  it('別 lane の新規 session が同期終了しても inactive lane の pending 表示更新を破棄する', () => {
    const h = createHarness();
    const requested = h.service.requestSession(makeLane('Old name'));
    h.service.refreshLane(makeLane('New name'));
    const oldTerminalId = h.attachSession(requested.handle, requested.profileTitle);
    const failure = new Error('attach failed');
    h.attachSession.mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => h.service.bindTerminal(requested.sessionId, oldTerminalId)).toThrow(failure);
    h.setExitOnSubscribe(true);

    h.service.revealLane(makeLane('Lane B', 'lane-b'));
    h.attachSession.mockClear();
    h.showTerminal.mockClear();

    h.service.finalizePendingPresentations();

    expect(h.attachSession).not.toHaveBeenCalled();
    expect(h.showTerminal).not.toHaveBeenCalled();
  });

  it('attach 失敗後に session が自然終了した場合は再試行で attach せず task を除去する', () => {
    const h = createHarness();
    h.service.revealLane(makeLane('Old name'));
    const failure = new Error('attach failed');
    h.attachSession.mockClear();
    h.attachSession.mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => h.service.refreshLane(makeLane('New name'))).toThrow(failure);
    h.handles[0]!.emitExit();
    h.attachSession.mockClear();

    h.service.refreshLane(makeLane('New name'));
    h.service.refreshLane(makeLane('Newest name'));

    expect(h.attachSession).not.toHaveBeenCalled();
  });

  it('rename の同期 close 通知は ownership 解除済みのため process を kill しない', () => {
    const h = createHarness();
    h.service.revealLane(makeLane('Old name'));
    h.setOnDisposeTerminal((terminalId) => h.service.handleTerminalClosed(terminalId));

    h.service.refreshLane(makeLane('New name'));

    expect(h.handles[0]!.kill).not.toHaveBeenCalled();
    expect(h.service.resolveLaneBySession('session-1' as SessionId)).toBe('lane-a');
  });

  it('先頭 session の kill が失敗しても後続 session を kill して全管理状態を除去する', () => {
    const h = createHarness();
    const lane = makeLane('Lane A');
    h.service.revealLane(lane);
    addBoundSession(h, lane);
    const failure = new Error('first kill failed');
    h.handles[0]!.kill.mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => h.service.closeLane(lane.id)).toThrow(failure);

    expect(h.handles[0]!.kill).toHaveBeenCalledOnce();
    expect(h.handles[1]!.kill).toHaveBeenCalledOnce();
    expect(h.handles[0]!.exitListenerCount()).toBe(0);
    expect(h.handles[1]!.exitListenerCount()).toBe(0);
    expect(h.service.resolveLaneBySession('session-1' as SessionId)).toBeUndefined();
    expect(h.service.resolveLaneBySession('session-2' as SessionId)).toBeUndefined();

    expect(() => h.service.closeLane(lane.id)).not.toThrow();
    expect(h.handles[0]!.kill).toHaveBeenCalledOnce();
    expect(h.handles[1]!.kill).toHaveBeenCalledOnce();
  });

  it('表示面の dispose が失敗しても対応 session の kill と後続 cleanup を実行する', () => {
    const h = createHarness();
    const lane = makeLane('Lane A');
    h.service.revealLane(lane);
    addBoundSession(h, lane);
    const failure = new Error('first dispose failed');
    h.disposeTerminal.mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => h.service.closeLane(lane.id)).toThrow(failure);

    expect(h.disposeTerminal).toHaveBeenCalledTimes(2);
    expect(h.handles[0]!.kill).toHaveBeenCalledOnce();
    expect(h.handles[1]!.kill).toHaveBeenCalledOnce();
    expect(h.handles[0]!.exitListenerCount()).toBe(0);
    expect(h.handles[1]!.exitListenerCount()).toBe(0);
    expect(() => h.service.closeLane(lane.id)).not.toThrow();
  });

  it('runtime dispose は kill 失敗を返しても全 session を一度だけ cleanup する', () => {
    const h = createHarness();
    h.service.revealLane(makeLane('Lane A'));
    addBoundSession(h, makeLane('Lane A'));
    const firstFailure = new Error('first kill failed');
    const secondFailure = new Error('second kill failed');
    h.handles[0]!.kill.mockImplementationOnce(() => {
      throw firstFailure;
    });
    h.handles[1]!.kill.mockImplementationOnce(() => {
      throw secondFailure;
    });

    const error = (() => {
      try {
        h.service.dispose();
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([firstFailure, secondFailure]);
    expect(h.handles[0]!.exitListenerCount()).toBe(0);
    expect(h.handles[1]!.exitListenerCount()).toBe(0);
    expect(() => h.service.dispose()).not.toThrow();
    expect(h.handles[0]!.kill).toHaveBeenCalledOnce();
    expect(h.handles[1]!.kill).toHaveBeenCalledOnce();
  });
});
