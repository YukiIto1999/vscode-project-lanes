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
});
