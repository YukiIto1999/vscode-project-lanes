import * as nodePath from 'node:path';
import type { AbsolutePath } from '../foundation/model';
import type { LaneQuery, LaneRoot, LaneSearchResult } from './model';

/**
 * content 検索の ripgrep 引数組立
 * @param query - 検証済みクエリ
 * @param roots - 検索対象レーンルート列
 * @returns ripgrep 引数列
 */
export const buildContentArgs = (
  query: LaneQuery,
  roots: readonly LaneRoot[],
): readonly string[] => [
  '--json',
  '--fixed-strings',
  '--smart-case',
  '--',
  query,
  ...roots.map((root) => root.rootPath),
];

/**
 * ファイル列挙の ripgrep 引数組立
 * @param roots - 検索対象レーンルート列
 * @returns ripgrep 引数列
 */
export const buildFileListArgs = (roots: readonly LaneRoot[]): readonly string[] => [
  '--files',
  ...roots.map((root) => root.rootPath),
];

/**
 * 絶対パスが配下に属するレーンの判定
 * @param roots - 候補レーンルート列
 * @param absolutePath - 判定対象の絶対パス
 * @returns 帰属レーンルート、入れ子は最長一致、該当なしで undefined
 */
export const attributeLane = (
  roots: readonly LaneRoot[],
  absolutePath: string,
): LaneRoot | undefined => {
  let matched: LaneRoot | undefined;
  for (const root of roots) {
    const within = absolutePath === root.rootPath || absolutePath.startsWith(`${root.rootPath}/`);
    if (!within) continue;
    if (!matched || root.rootPath.length > matched.rootPath.length) matched = root;
  }
  return matched;
};

const toRelative = (root: LaneRoot, absolutePath: string): string =>
  nodePath.relative(root.rootPath, absolutePath);

/** ripgrep --json の match イベント形状 */
interface RipgrepEvent {
  readonly type?: string;
  readonly data?: {
    readonly path?: { readonly text?: string };
    readonly lines?: { readonly text?: string };
    readonly line_number?: number;
    readonly submatches?: ReadonlyArray<{ readonly start?: number }>;
  };
}

/**
 * ripgrep --json 出力からの content ヒット抽出
 * @param stdout - ripgrep の標準出力
 * @param roots - 帰属判定用レーンルート列
 * @param limit - 抽出上限
 * @returns ヒット列と上限到達フラグ
 */
export const parseContentMatches = (
  stdout: string,
  roots: readonly LaneRoot[],
  limit: number,
): { readonly results: readonly LaneSearchResult[]; readonly truncated: boolean } => {
  const results: LaneSearchResult[] = [];
  let truncated = false;
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    if (results.length >= limit) {
      truncated = true;
      break;
    }
    let event: RipgrepEvent;
    try {
      event = JSON.parse(line) as RipgrepEvent;
    } catch {
      continue;
    }
    if (event.type !== 'match' || !event.data) continue;
    const pathText = event.data.path?.text;
    const lineNumber = event.data.line_number;
    if (pathText === undefined || lineNumber === undefined) continue;
    const root = attributeLane(roots, pathText);
    if (!root) continue;
    // submatches[0].start は行内 0 始まり byte offset、1 始まり桁へ補正
    const column = (event.data.submatches?.[0]?.start ?? 0) + 1;
    const preview = (event.data.lines?.text ?? '').replace(/\r?\n$/, '').trim();
    results.push({
      kind: 'content',
      laneId: root.laneId,
      path: pathText as AbsolutePath,
      relativePath: toRelative(root, pathText),
      line: lineNumber,
      column,
      preview,
    });
  }
  return { results, truncated };
};

/**
 * ripgrep --files 出力からの file ヒット抽出
 * @param stdout - ripgrep の標準出力
 * @param roots - 帰属判定用レーンルート列
 * @returns ファイルヒット列
 */
export const parseFileList = (
  stdout: string,
  roots: readonly LaneRoot[],
): readonly LaneSearchResult[] => {
  const results: LaneSearchResult[] = [];
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const root = attributeLane(roots, line);
    if (!root) continue;
    results.push({
      kind: 'file',
      laneId: root.laneId,
      path: line as AbsolutePath,
      relativePath: toRelative(root, line),
    });
  }
  return results;
};
