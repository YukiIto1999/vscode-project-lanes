import type * as NodePty from 'node-pty';
import { describe, expect, it, vi } from 'vitest';
import type { AbsolutePath, Disposable, LaneId, SessionId } from '../../foundation/model';
import type { SessionActivitySink } from '../../lane-activity/ports';
import type { TerminalSessionSpec } from '../../terminal/model';
import { createShellSessionFactory } from './node-pty';

const activitySink = {
  executionStarted: vi.fn(),
  executionEnded: vi.fn(),
  output: vi.fn(),
  input: vi.fn(),
  forgotten: vi.fn(),
} satisfies SessionActivitySink;

const spec: TerminalSessionSpec = {
  id: 'session-a' as SessionId,
  laneId: 'lane-a' as LaneId,
  cwdPath: '/projects/lane-a' as AbsolutePath,
  shellPath: '/bin/bash' as AbsolutePath,
};

/**
 * 出力通知を手動で発火できる PTY を持つセッションの生成
 * @returns セッションハンドルと出力通知
 */
const createOutputHarness = () => {
  let notifyData: ((data: string) => void) | undefined;
  const proc = {
    onData: vi.fn((listener: (data: string) => void) => {
      notifyData = listener;
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  };
  const factory = createShellSessionFactory({
    extensionPath: '/extension' as AbsolutePath,
    activitySink,
    loadPty: () =>
      ({
        spawn: vi.fn(() => proc),
      }) as unknown as typeof NodePty,
  });
  return {
    handle: factory.create(spec),
    emit: (data: string) => notifyData!(data),
  };
};

describe('createShellSessionFactory', () => {
  it('終了通知中に購読解除されても登録時点の全 listener を一度ずつ呼ぶ', () => {
    let notifyExit: (() => void) | undefined;
    const proc = {
      onData: vi.fn(),
      onExit: vi.fn((listener: () => void) => {
        notifyExit = listener;
        return { dispose: vi.fn() };
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    const factory = createShellSessionFactory({
      extensionPath: '/extension' as AbsolutePath,
      activitySink,
      loadPty: () =>
        ({
          spawn: vi.fn(() => proc),
        }) as unknown as typeof NodePty,
    });
    const handle = factory.create(spec);
    const second = vi.fn();
    let firstSubscription!: Disposable;
    const first = vi.fn(() => firstSubscription.dispose());
    firstSubscription = handle.onExit(first);
    handle.onExit(second);

    notifyExit!();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('古い出力接続の dispose は後から接続した listener を解除しない', () => {
    let notifyData: ((data: string) => void) | undefined;
    const proc = {
      onData: vi.fn((listener: (data: string) => void) => {
        notifyData = listener;
        return { dispose: vi.fn() };
      }),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    const factory = createShellSessionFactory({
      extensionPath: '/extension' as AbsolutePath,
      activitySink,
      loadPty: () =>
        ({
          spawn: vi.fn(() => proc),
        }) as unknown as typeof NodePty,
    });
    const handle = factory.create(spec);
    const oldListener = vi.fn();
    const newListener = vi.fn();
    const oldConnection = handle.attachOutput(oldListener);
    handle.attachOutput(newListener);

    oldConnection.dispose();
    notifyData!('new output');

    expect(oldListener).not.toHaveBeenCalled();
    expect(newListener).toHaveBeenCalledWith('new output');
  });

  it('終了済みシェルへの resize と write を PTY へ渡さず、終了直前の resize 失敗も握る', () => {
    let notifyExit: (() => void) | undefined;
    const proc = {
      onData: vi.fn(),
      onExit: vi.fn((listener: () => void) => {
        notifyExit = listener;
        return { dispose: vi.fn() };
      }),
      write: vi.fn(),
      resize: vi.fn(() => {
        throw new Error('ioctl(2) failed, EBADF');
      }),
      kill: vi.fn(),
    };
    const factory = createShellSessionFactory({
      extensionPath: '/extension' as AbsolutePath,
      activitySink,
      loadPty: () =>
        ({
          spawn: vi.fn(() => proc),
        }) as unknown as typeof NodePty,
    });
    const handle = factory.create(spec);

    expect(() => handle.resize(80, 24)).not.toThrow();
    expect(proc.resize).toHaveBeenCalledOnce();

    notifyExit!();
    handle.resize(100, 30);
    handle.write('ls\n');

    expect(proc.resize).toHaveBeenCalledOnce();
    expect(proc.write).not.toHaveBeenCalled();
  });

  it('表示面へ届け済みの端末問い合わせを再接続時の再生から除く', () => {
    const { handle, emit } = createOutputHarness();
    const firstConnection = handle.attachOutput(vi.fn());
    emit('$ printf');
    emit('\x1b[c\x1b]11;?\x07\r\n$ ');
    firstConnection.dispose();
    const replay = vi.fn();

    handle.attachOutput(replay);

    expect(replay).toHaveBeenCalledExactlyOnceWith('$ printf\r\n$ ');
  });

  it('表示面の接続前に届いた端末問い合わせは初回の再生だけに残す', () => {
    const { handle, emit } = createOutputHarness();
    emit('\x1b[?u\x1b[c');
    const first = vi.fn();
    const second = vi.fn();

    handle.attachOutput(first).dispose();
    handle.attachOutput(second);

    expect(first).toHaveBeenCalledExactlyOnceWith('\x1b[?u\x1b[c');
    expect(second).not.toHaveBeenCalled();
  });

  it('未接続の間に届いた出力は届け済みの出力と分けて応答可能なまま再生する', () => {
    const { handle, emit } = createOutputHarness();
    const connection = handle.attachOutput(vi.fn());
    emit('a\x1b[6n');
    connection.dispose();
    emit('b\x1b[6n');
    const replay = vi.fn();

    handle.attachOutput(replay);

    expect(replay).toHaveBeenCalledExactlyOnceWith('ab\x1b[6n');
  });

  it('届け済み出力の末尾で途切れた問い合わせは未配信の続きと連結して残す', () => {
    const { handle, emit } = createOutputHarness();
    const connection = handle.attachOutput(vi.fn());
    emit('\x1b[6');
    connection.dispose();
    emit('n');
    const replay = vi.fn();

    handle.attachOutput(replay);

    expect(replay).toHaveBeenCalledExactlyOnceWith('\x1b[6n');
  });

  it('scrollback の切り詰めで制御列の途中から始まる再生を平文のまま渡す', () => {
    const { handle, emit } = createOutputHarness();
    handle.attachOutput(vi.fn());
    const retained = `6n${'y'.repeat(40 * 1024)}`;
    emit(`${'x'.repeat(30 * 1024)}\x1b[`);
    emit(retained);
    const replay = vi.fn();

    handle.attachOutput(replay);

    expect(replay).toHaveBeenCalledExactlyOnceWith(retained);
  });

  it('切り詰めた届け済み chunk の分だけ未配信の境界を前へ詰める', () => {
    const { handle, emit } = createOutputHarness();
    const connection = handle.attachOutput(vi.fn());
    emit(`${'x'.repeat(40 * 1024)}\x1b[c`);
    connection.dispose();
    const pending = `\x1b[c${'y'.repeat(30 * 1024)}`;
    emit(pending);
    emit('\x1b[6n');
    const replay = vi.fn();

    handle.attachOutput(replay);

    expect(replay).toHaveBeenCalledExactlyOnceWith(`${pending}\x1b[6n`);
  });
});
