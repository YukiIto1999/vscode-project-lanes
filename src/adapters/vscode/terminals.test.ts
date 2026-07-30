import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '../../foundation/model';
import type { SessionActivitySink } from '../../lane-activity/ports';
import type { ShellSessionHandle } from '../../terminal/ports';

const vscodeHarness = vi.hoisted(() => {
  const createdOptions: unknown[] = [];
  const createdTerminals: {
    readonly creationOptions: unknown;
    readonly show: ReturnType<typeof vi.fn>;
    readonly dispose: ReturnType<typeof vi.fn>;
  }[] = [];
  let openListener: ((terminal: unknown) => void) | undefined;

  class EventEmitter {
    readonly event = vi.fn();
    readonly fire = vi.fn();
    readonly dispose = vi.fn();
  }

  class TerminalProfile {
    constructor(readonly options: unknown) {}
  }

  return {
    createdOptions,
    createdTerminals,
    getOpenListener: () => openListener,
    reset: () => {
      createdOptions.splice(0);
      createdTerminals.splice(0);
      openListener = undefined;
    },
    vscode: {
      EventEmitter,
      TerminalProfile,
      window: {
        createTerminal: vi.fn((options: unknown) => {
          createdOptions.push(options);
          const terminal = {
            creationOptions: options,
            show: vi.fn(),
            dispose: vi.fn(),
          };
          createdTerminals.push(terminal);
          return terminal;
        }),
        onDidOpenTerminal: vi.fn((listener: (terminal: unknown) => void) => {
          openListener = listener;
          return { dispose: vi.fn() };
        }),
      },
    },
  };
});

vi.mock('vscode', () => vscodeHarness.vscode);

import { createTerminalPresentationAdapter } from './terminals';

const session = {
  id: 'session-a' as SessionId,
  write: vi.fn(),
  resize: vi.fn(),
  attachOutput: vi.fn(() => ({ dispose: vi.fn() })),
  onExit: vi.fn(() => ({ dispose: vi.fn() })),
  kill: vi.fn(),
} satisfies ShellSessionHandle;

const activitySink = {
  executionStarted: vi.fn(),
  executionEnded: vi.fn(),
  output: vi.fn(),
  input: vi.fn(),
  forgotten: vi.fn(),
} satisfies SessionActivitySink;

describe('createTerminalPresentationAdapter', () => {
  beforeEach(() => {
    vscodeHarness.reset();
  });

  it('直接生成する custom PTY を transient terminal として作る', () => {
    const adapter = createTerminalPresentationAdapter({ activitySink });

    adapter.attachSession(session, 'lane-a');

    expect(vscodeHarness.createdOptions).toEqual([
      expect.objectContaining({
        name: 'lane-a',
        isTransient: true,
      }),
    ]);
  });

  it('TerminalProfile の custom PTY を transient terminal として作る', () => {
    const adapter = createTerminalPresentationAdapter({ activitySink });

    const profile = adapter.presentAsProfile(session, 'lane-a', vi.fn()) as unknown as {
      options: unknown;
    };

    expect(profile.options).toEqual(
      expect.objectContaining({
        name: 'lane-a',
        isTransient: true,
      }),
    );
  });

  it('VS Code 側で閉じた Terminal は再 dispose せず管理対象から外す', () => {
    const adapter = createTerminalPresentationAdapter({ activitySink });
    const terminalId = adapter.attachSession(session, 'lane-a');
    const terminal = vscodeHarness.createdTerminals[0]!;

    adapter.forgetTerminal(terminalId);

    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(adapter.disposeAllOwned()).toEqual([]);
  });

  it('preserveFocus を VS Code Terminal.show へ渡す', () => {
    const adapter = createTerminalPresentationAdapter({ activitySink });
    const terminalId = adapter.attachSession(session, 'lane-a');
    const terminal = vscodeHarness.createdTerminals[0]!;

    adapter.showTerminal(terminalId, true);

    expect(terminal.show).toHaveBeenCalledWith(true);
  });

  it('Pseudoterminal close は自身が取得した出力接続だけを dispose する', () => {
    const outputConnection = { dispose: vi.fn() };
    const ownedSession = {
      ...session,
      attachOutput: vi.fn(() => outputConnection),
    } satisfies ShellSessionHandle;
    const adapter = createTerminalPresentationAdapter({ activitySink });

    adapter.attachSession(ownedSession, 'lane-a');
    const pty = vscodeHarness.createdOptions[0] as {
      readonly pty: {
        readonly open: (dimensions: undefined) => void;
        readonly close: () => void;
      };
    };
    pty.pty.open(undefined);
    pty.pty.close();

    expect(outputConnection.dispose).toHaveBeenCalledOnce();
  });

  it('Terminal dispose が失敗しても管理対象から除外する', () => {
    const failure = new Error('terminal dispose failed');
    const adapter = createTerminalPresentationAdapter({ activitySink });
    const terminalId = adapter.attachSession(session, 'lane-a');
    const terminal = vscodeHarness.createdTerminals[0]!;
    terminal.dispose.mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => adapter.disposeTerminal(terminalId)).toThrow(failure);
    expect(adapter.disposeAllOwned()).toEqual([]);
  });
});
