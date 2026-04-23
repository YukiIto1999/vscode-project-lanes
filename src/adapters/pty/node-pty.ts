import type * as NodePty from 'node-pty';
import type { Disposable } from '../../foundation/model';
import type { ShellSessionFactoryPort, ShellSessionHandle } from '../../terminal/ports';

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

/**
 * node-pty ベースのシェルセッション生成アダプターの生成
 * @returns シェルセッション生成ポート
 */
export const createShellSessionFactory = (): ShellSessionFactoryPort => ({
  create: (spec): ShellSessionHandle => {
    const pty = loadPty();
    const shell = spec.shellPath ?? detectShell();
    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: spec.cwdPath,
      env: { ...process.env, LANES_SESSION_ID: spec.id } as Record<string, string>,
    });

    let alive = true;
    const exitCallbacks: (() => void)[] = [];
    const scrollbackChunks: string[] = [];
    let scrollbackSize = 0;
    let currentListener: ((data: string) => void) | undefined;

    const trimScrollback = () => {
      while (scrollbackSize > MAX_SCROLLBACK && scrollbackChunks.length > 1) {
        scrollbackSize -= scrollbackChunks.shift()!.length;
      }
    };

    proc.onData((data) => {
      scrollbackChunks.push(data);
      scrollbackSize += data.length;
      trimScrollback();
      currentListener?.(data);
    });

    proc.onExit(() => {
      alive = false;
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
