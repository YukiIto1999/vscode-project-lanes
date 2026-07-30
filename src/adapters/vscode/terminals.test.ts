import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '../../foundation/model';
import type { SessionActivitySink } from '../../lane-activity/ports';
import type { ShellSessionHandle } from '../../terminal/ports';

const vscodeHarness = vi.hoisted(() => {
  const createdOptions: unknown[] = [];
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
    getOpenListener: () => openListener,
    reset: () => {
      createdOptions.splice(0);
      openListener = undefined;
    },
    vscode: {
      EventEmitter,
      TerminalProfile,
      window: {
        createTerminal: vi.fn((options: unknown) => {
          createdOptions.push(options);
          return {
            creationOptions: options,
            show: vi.fn(),
            dispose: vi.fn(),
          };
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
  attachOutput: vi.fn(),
  detachOutput: vi.fn(),
  onExit: vi.fn(() => ({ dispose: vi.fn() })),
  kill: vi.fn(),
  isAlive: vi.fn(() => true),
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
});
