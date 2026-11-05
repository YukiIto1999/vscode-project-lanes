import type * as NodePty from 'node-pty';
import type { AbsolutePath, Disposable } from '../../foundation/model';
import type { SessionActivitySink } from '../../lane-activity/ports';
import type { ShellSessionFactoryPort, ShellSessionHandle } from '../../terminal/ports';
import { initialParserState, parseChunk, type ParserState } from './osc633';
import { planShellIntegration } from './shell-integration';
import { stripTerminalQueries } from './terminal-query';

/**
 * node-pty の遅延ロード
 * @returns node-pty モジュール
 */
const loadPty = (): typeof NodePty => require('node-pty');

const MAX_SCROLLBACK = 64 * 1024;

/**
 * 既定シェルの検出
 * @returns シェル絶対パス
 */
const detectShell = (): string => process.env.SHELL ?? '/bin/bash';

/** node-pty ファクトリの依存 */
export interface ShellSessionFactoryDeps {
  /** シェル統合スクリプト解決の起点となる拡張ルート絶対パス */
  readonly extensionPath: AbsolutePath;
  /** セッション活動の事実流入口 */
  readonly activitySink: SessionActivitySink;
  /** node-pty モジュールのロード。テスト時のみ差し替える */
  readonly loadPty?: () => typeof NodePty;
}

/**
 * node-pty ベースのシェルセッション生成アダプターの生成
 * @param deps - 依存
 * @returns シェルセッション生成ポート
 */
export const createShellSessionFactory = (
  deps: ShellSessionFactoryDeps,
): ShellSessionFactoryPort => ({
  create: (spec): ShellSessionHandle => {
    const pty = deps.loadPty?.() ?? loadPty();
    const shellPath = spec.shellPath ?? detectShell();
    const baseEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PWD: spec.cwdPath,
      LANES_SESSION_ID: spec.id,
    };
    const plan = planShellIntegration(shellPath, baseEnv, deps.extensionPath);

    const proc = pty.spawn(shellPath, [...plan.args], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: spec.cwdPath,
      env: { ...plan.env },
    });

    let alive = true;
    const exitCallbacks: (() => void)[] = [];
    const scrollbackChunks: string[] = [];
    let scrollbackSize = 0;
    /** 表示面へ届け済みの scrollback 先頭 chunk 数 */
    let deliveredChunkCount = 0;
    let currentOutput:
      | {
          readonly listener: (data: string) => void;
        }
      | undefined;
    let parserState: ParserState = initialParserState();

    const trimScrollback = (): void => {
      while (scrollbackSize > MAX_SCROLLBACK && scrollbackChunks.length > 1) {
        scrollbackSize -= scrollbackChunks.shift()!.length;
        if (deliveredChunkCount > 0) deliveredChunkCount -= 1;
      }
    };

    const dispatchActivity = (chunk: string): void => {
      const result = parseChunk(parserState, chunk);
      parserState = result.state;
      for (const event of result.events) {
        switch (event.kind) {
          case 'fg-started':
            deps.activitySink.executionStarted(spec.id);
            break;
          case 'fg-ended':
            deps.activitySink.executionEnded(spec.id);
            break;
          case 'output':
            deps.activitySink.output(spec.id);
            break;
        }
      }
    };

    proc.onData((data) => {
      scrollbackChunks.push(data);
      scrollbackSize += data.length;
      if (currentOutput) deliveredChunkCount = scrollbackChunks.length;
      trimScrollback();
      dispatchActivity(data);
      currentOutput?.listener(data);
    });

    proc.onExit(() => {
      alive = false;
      deps.activitySink.forgotten(spec.id);
      const callbacks = exitCallbacks.splice(0);
      for (const callback of callbacks) callback();
    });

    return {
      id: spec.id,
      write: (data) => {
        if (alive) proc.write(data);
      },
      // 終了済み PTY の resize は EBADF を投げ、fd 再利用時は別 PTY を操作し得るため生存中に限る
      resize: (cols, rows) => {
        if (!alive) return;
        try {
          proc.resize(cols, rows);
        } catch {
          // onExit 通知前に終了した PTY の resize 失敗を表示処理へ波及させない
        }
      },

      attachOutput: (callback) => {
        const output = { listener: callback };
        currentOutput = output;
        // 届け済みの問い合わせには以前の表示面が応答したため、再生では応答させない
        const replay =
          stripTerminalQueries(scrollbackChunks.slice(0, deliveredChunkCount).join('')) +
          scrollbackChunks.slice(deliveredChunkCount).join('');
        deliveredChunkCount = scrollbackChunks.length;
        if (replay.length > 0) callback(replay);
        return {
          dispose: () => {
            if (currentOutput === output) currentOutput = undefined;
          },
        };
      },

      onExit: (callback): Disposable => {
        if (!alive) {
          callback();
          return { dispose: () => {} };
        }
        exitCallbacks.push(callback);
        return {
          dispose: () => {
            const idx = exitCallbacks.indexOf(callback);
            if (idx >= 0) exitCallbacks.splice(idx, 1);
          },
        };
      },

      kill: () => {
        if (alive) proc.kill();
      },
    };
  },
});
