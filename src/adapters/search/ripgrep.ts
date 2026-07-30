import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';
import type { Disposable } from '../../foundation/model';
import type { LaneQuery, LaneRoot, LaneSearchOutcome, LaneSearchResult } from '../../search/model';
import type { LaneSearchPort } from '../../search/ports';
import {
  buildContentArgs,
  buildFileListArgs,
  parseContentMatchLine,
  parseFileLine,
} from '../../search/ripgrep';

/** content 検索の抽出上限 */
const MAX_CONTENT_RESULTS = 2000;
/** 標準出力の単一論理行の UTF-16 code unit 上限 */
const MAX_OUTPUT_LINE_CODE_UNITS = 1024 * 1024;
/** エラーへ保持する標準エラー出力の byte 上限 */
const MAX_STDERR_TAIL_BYTES = 64 * 1024;

/**
 * 同梱 ripgrep バイナリパスの解決
 * @returns platform 別パッケージのバイナリパス、解決不能で undefined
 */
const resolveRgPath = (): string | undefined => {
  try {
    const requireFrom = createRequire(__filename);
    return requireFrom.resolve(`@vscode/ripgrep-${process.platform}-${process.arch}/bin/rg`);
  } catch {
    return undefined;
  }
};

/** ripgrep 検索アダプター */
export interface RipgrepSearchAdapter extends LaneSearchPort {
  /** 実行中検索の取消 */
  readonly disposable: Disposable;
}

/** 実行中 ripgrep の所有情報 */
interface ActiveRun {
  /** runtime 破棄による取消 */
  readonly cancel: () => void;
}

type LineConsumer = (line: string) => LaneSearchOutcome | undefined;

const errorCodeOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null && 'code' in error
    ? (error as { readonly code?: unknown }).code
    : undefined;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * ripgrep backend error の生成
 * @param context - 失敗箇所
 * @param cause - 原因
 * @param stderrTail - 標準エラー出力末尾
 * @returns 呼出元へ返す Error
 */
const backendError = (context: string, cause: unknown, stderrTail: Buffer): Error => {
  const stderr = stderrTail.toString('utf8');
  const detail = stderr.length === 0 ? '' : `\n${stderr}`;
  return new Error(`${context}: ${messageOf(cause)}${detail}`, { cause });
};

/**
 * ripgrep を用いた横断検索アダプターの生成
 * @returns 横断検索バックエンドポートと破棄処理
 */
export const createRipgrepSearchAdapter = (): RipgrepSearchAdapter => {
  const activeRuns = new Set<ActiveRun>();
  let disposed = false;

  const execute = (
    args: readonly string[],
    consumeLine: LineConsumer,
    completedOutcome: () => LaneSearchOutcome,
  ): Promise<LaneSearchOutcome> => {
    if (disposed) return Promise.resolve({ kind: 'cancelled' });

    const rgPath = resolveRgPath();
    if (rgPath === undefined) return Promise.resolve({ kind: 'unavailable' });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(rgPath, [...args], { shell: false });
    } catch (error) {
      return errorCodeOf(error) === 'ENOENT'
        ? Promise.resolve({ kind: 'unavailable' })
        : Promise.reject(backendError('ripgrep spawn failed', error, Buffer.alloc(0)));
    }

    return new Promise<LaneSearchOutcome>((resolve, reject) => {
      const decoder = new StringDecoder('utf8');
      let bufferedLine = '';
      let stderrTail: Buffer = Buffer.alloc(0);
      let settled = false;
      let killed = false;

      const appendStderr = (chunk: Buffer | string): void => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
        if (bytes.length >= MAX_STDERR_TAIL_BYTES) {
          stderrTail = Buffer.from(bytes.subarray(bytes.length - MAX_STDERR_TAIL_BYTES));
          return;
        }
        const combined = Buffer.concat([stderrTail, bytes]);
        stderrTail =
          combined.length <= MAX_STDERR_TAIL_BYTES
            ? combined
            : combined.subarray(combined.length - MAX_STDERR_TAIL_BYTES);
      };

      const killOnce = (): void => {
        if (killed) return;
        killed = true;
        try {
          child.kill();
        } catch {
          // 呼出しの完了契約を kill 自体の失敗より優先
        }
      };

      const removeActiveRun = (): void => {
        activeRuns.delete(activeRun);
      };

      const removeDataListeners = (): void => {
        child.stdout.removeListener('data', onStdoutData);
        child.stderr.removeListener('data', onStderrData);
      };

      const cleanupListeners = (): void => {
        removeDataListeners();
        child.stdout.removeListener('error', onStdoutError);
        child.stderr.removeListener('error', onStderrError);
        child.removeListener('error', onChildError);
        child.removeListener('close', onChildClose);
      };

      const resolveOnce = (outcome: LaneSearchOutcome): void => {
        if (settled) return;
        settled = true;
        removeActiveRun();
        removeDataListeners();
        resolve(outcome);
      };

      const rejectOnce = (error: Error): void => {
        if (settled) return;
        settled = true;
        removeActiveRun();
        removeDataListeners();
        reject(error);
      };

      const fail = (context: string, cause: unknown): void => {
        if (settled) return;
        const error = backendError(context, cause, stderrTail);
        rejectOnce(error);
        killOnce();
      };

      const stopWith = (outcome: LaneSearchOutcome): void => {
        if (settled) return;
        resolveOnce(outcome);
        killOnce();
      };

      const consume = (line: string): boolean => {
        if (settled || line.length === 0) return settled;
        try {
          const outcome = consumeLine(line);
          if (outcome) stopWith(outcome);
        } catch (error) {
          fail('ripgrep output parsing failed', error);
        }
        return settled;
      };

      const consumeChunk = (text: string): void => {
        if (settled) return;
        let cursor = 0;
        while (!settled) {
          const newlineIndex = text.indexOf('\n', cursor);
          const fragmentEnd = newlineIndex >= 0 ? newlineIndex : text.length;
          const fragmentLength = fragmentEnd - cursor;
          if (bufferedLine.length + fragmentLength > MAX_OUTPUT_LINE_CODE_UNITS) {
            fail(
              'ripgrep output line exceeded limit',
              new Error(`${MAX_OUTPUT_LINE_CODE_UNITS} UTF-16 code units`),
            );
            return;
          }
          bufferedLine += text.slice(cursor, fragmentEnd);
          if (newlineIndex < 0) return;

          const line = bufferedLine;
          bufferedLine = '';
          if (consume(line)) return;
          cursor = newlineIndex + 1;
        }
      };

      const activeRun: ActiveRun = {
        cancel: () => {
          if (settled) return;
          resolveOnce({ kind: 'cancelled' });
          killOnce();
        },
      };
      activeRuns.add(activeRun);

      function onStdoutData(chunk: Buffer | string): void {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
        consumeChunk(decoder.write(bytes));
      }

      function onStdoutError(error: Error): void {
        fail('ripgrep stdout failed', error);
      }

      function onStderrData(chunk: Buffer | string): void {
        appendStderr(chunk);
      }

      function onStderrError(error: Error): void {
        fail('ripgrep stderr failed', error);
      }

      function onChildError(error: Error): void {
        if (settled) return;
        if (errorCodeOf(error) === 'ENOENT') {
          resolveOnce({ kind: 'unavailable' });
          return;
        }
        fail('ripgrep process failed', error);
      }

      function onChildClose(code: number | null, signal: NodeJS.Signals | null): void {
        cleanupListeners();
        if (settled) return;
        consumeChunk(decoder.end());
        if (settled) return;
        if (bufferedLine.length > 0 && consume(bufferedLine)) return;
        bufferedLine = '';
        if (code === 0 || code === 1) {
          resolveOnce(completedOutcome());
          return;
        }
        const termination =
          typeof code === 'number'
            ? new Error(`exit code ${code}`)
            : new Error(`terminated by signal ${signal ?? 'unknown'}`);
        rejectOnce(backendError('ripgrep exited unsuccessfully', termination, stderrTail));
      }

      child.stdout.on('data', onStdoutData);
      child.stdout.on('error', onStdoutError);
      child.stderr.on('data', onStderrData);
      child.stderr.on('error', onStderrError);
      child.on('error', onChildError);
      child.on('close', onChildClose);
    });
  };

  const adapter: RipgrepSearchAdapter = {
    searchContent: (query: LaneQuery, roots: readonly LaneRoot[]): Promise<LaneSearchOutcome> => {
      if (disposed) return Promise.resolve({ kind: 'cancelled' });
      if (roots.length === 0) {
        return Promise.resolve({ kind: 'results', results: [], truncated: false });
      }

      const results: LaneSearchResult[] = [];
      return execute(
        buildContentArgs(query, roots),
        (line) => {
          const result = parseContentMatchLine(line, roots);
          if (!result) return undefined;
          if (results.length === MAX_CONTENT_RESULTS) {
            return { kind: 'results', results, truncated: true };
          }
          results.push(result);
          return undefined;
        },
        () => ({ kind: 'results', results, truncated: false }),
      );
    },

    listFiles: (roots: readonly LaneRoot[]): Promise<LaneSearchOutcome> => {
      if (disposed) return Promise.resolve({ kind: 'cancelled' });
      if (roots.length === 0) {
        return Promise.resolve({ kind: 'results', results: [], truncated: false });
      }

      const results: LaneSearchResult[] = [];
      return execute(
        buildFileListArgs(roots),
        (line) => {
          const result = parseFileLine(line, roots);
          if (result) results.push(result);
          return undefined;
        },
        () => ({ kind: 'results', results, truncated: false }),
      );
    },

    disposable: {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        for (const run of activeRuns) run.cancel();
      },
    },
  };

  return adapter;
};
