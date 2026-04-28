import * as vscode from 'vscode';
import type { Disposable, TerminalId } from '../../foundation/model';
import type { TerminalOutputEventPort } from '../../lane-activity/ports';

/** 出力イベント源 */
export interface TerminalOutputSource {
  /** ターミナル出力観測イベント */
  readonly onTerminalOutput: vscode.Event<TerminalId>;
}

/** ターミナル出力イベントアダプター */
export interface TerminalOutputEventAdapter extends TerminalOutputEventPort {
  /** VS Code 購読の解放 */
  readonly disposable: Disposable;
}

/**
 * 出力源から TerminalOutputEventPort への整流
 * @param source - 出力源
 * @returns イベントアダプター
 */
export const createTerminalOutputEventAdapter = (
  source: TerminalOutputSource,
): TerminalOutputEventAdapter => {
  const handlers: Array<(event: { readonly terminalId: TerminalId }) => void> = [];

  const subscription = source.onTerminalOutput((terminalId) => {
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
