import * as vscode from 'vscode';
import type { Disposable, TerminalId } from '../../foundation/model';
import type { TerminalInputEventPort } from '../../lane-activity/ports';

/** 入力イベント源 */
export interface TerminalInputSource {
  /** ターミナル入力観測の生イベント */
  readonly onTerminalInput: vscode.Event<TerminalId>;
}

/** ターミナル入力イベントアダプター */
export interface TerminalInputEventAdapter extends TerminalInputEventPort {
  /** VS Code 購読の解放 */
  readonly disposable: Disposable;
}

/**
 * 入力源から TerminalInputEventPort への整流
 * @param source - 入力源
 * @returns イベントアダプター
 */
export const createTerminalInputEventAdapter = (
  source: TerminalInputSource,
): TerminalInputEventAdapter => {
  const handlers: Array<(event: { readonly terminalId: TerminalId }) => void> = [];

  const subscription = source.onTerminalInput((terminalId) => {
    for (const handler of handlers) handler({ terminalId });
  });

  return {
    subscribe: (handler) => {
      handlers.push(handler);
      return {
        dispose: () => {
          const idx = handlers.indexOf(handler);
          if (idx >= 0) handlers.splice(idx, 1);
        },
      };
    },
    disposable: {
      dispose: () => {
        subscription.dispose();
        handlers.length = 0;
      },
    },
  };
};
