import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import type { LaneQuery, LaneRoot, LaneSearchOutcome } from '../../search/model';
import type { LaneSearchPort } from '../../search/ports';
import {
  buildContentArgs,
  buildFileListArgs,
  parseContentMatches,
  parseFileList,
} from '../../search/ripgrep';

/** content 検索の抽出上限 */
const MAX_CONTENT_RESULTS = 2000;
/** ripgrep 標準出力の最大バッファ */
const MAX_BUFFER = 64 * 1024 * 1024;

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

/** ripgrep 起動の結果 */
type RunResult = { readonly ok: true; readonly stdout: string } | { readonly ok: false };

/**
 * ripgrep の起動
 * @param args - ripgrep 引数列
 * @returns 標準出力、またはバイナリ不在/異常終了で ok=false
 */
const runRipgrep = (args: readonly string[]): Promise<RunResult> =>
  new Promise((resolve) => {
    const rgPath = resolveRgPath();
    if (rgPath === undefined) {
      resolve({ ok: false });
      return;
    }
    execFile(rgPath, [...args], { maxBuffer: MAX_BUFFER }, (error, stdout) => {
      if (!error) {
        resolve({ ok: true, stdout });
        return;
      }
      // exit code 1 は「一致 0 件」で正常。ENOENT や exit code 2 以上は不在/異常
      const code = (error as { code?: unknown }).code;
      if (code === 1) {
        resolve({ ok: true, stdout });
        return;
      }
      resolve({ ok: false });
    });
  });

/**
 * ripgrep を用いた横断検索アダプターの生成
 * @returns 横断検索バックエンドポート
 */
export const createRipgrepSearchAdapter = (): LaneSearchPort => ({
  searchContent: async (
    query: LaneQuery,
    roots: readonly LaneRoot[],
  ): Promise<LaneSearchOutcome> => {
    if (roots.length === 0) return { kind: 'results', results: [], truncated: false };
    const run = await runRipgrep(buildContentArgs(query, roots));
    if (!run.ok) return { kind: 'unavailable' };
    const { results, truncated } = parseContentMatches(run.stdout, roots, MAX_CONTENT_RESULTS);
    return { kind: 'results', results, truncated };
  },

  listFiles: async (roots: readonly LaneRoot[]): Promise<LaneSearchOutcome> => {
    if (roots.length === 0) return { kind: 'results', results: [], truncated: false };
    const run = await runRipgrep(buildFileListArgs(roots));
    if (!run.ok) return { kind: 'unavailable' };
    return { kind: 'results', results: parseFileList(run.stdout, roots), truncated: false };
  },
});
