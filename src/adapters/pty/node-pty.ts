import type * as NodePty from 'node-pty';
import type { AbsolutePath, Disposable } from '../../foundation/model';
import type { SessionActivitySink } from '../../lane-activity/ports';
import type { ShellSessionFactoryPort, ShellSessionHandle } from '../../terminal/ports';
import { initialParserState, parseChunk, type ParserState } from './osc633';
import { planShellIntegration } from './shell-integration';

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
  /** 拡張ルート絶対パス (シェル統合スクリプト解決用) */
  readonly extensionPath: AbsolutePath;
  /** セッション活動の事実流入口 */
  readonly activitySink: SessionActivitySink;
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
    const pty = loadPty();
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
    let currentListener: ((data: string) => void) | undefined;
    let parserState: ParserState = initialParserState();

    const trimScrollback = (): void => {
      while (scrollbackSize > MAX_SCROLLBACK && scrollbackChunks.length > 1) {
        scrollbackSize -= scrollbackChunks.shift()!.length;
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
      trimScrollback();
      dispatchActivity(data);
      currentListener?.(data);
    });

    proc.onExit(() => {
      alive = false;
      deps.activitySink.forgotten(spec.id);
      for (const cb of exitCallbacks) cb();
    });

    return {
      id: spec.id,
      write: (data) => proc.write(data),
      resize: (cols, rows) => proc.resize(cols, rows),

      attachOutput: (callback) => {
        currentListener = callback;
        if (scrollbackChunks.length > 0) callback(scrollbackChunks.join(''));
      },

      detachOutput: () => {
        currentListener = undefined;
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
      isAlive: () => alive,
    };
  },
});
