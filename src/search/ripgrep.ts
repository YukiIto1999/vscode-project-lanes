import * as nodePath from 'node:path';
import { TextDecoder } from 'node:util';
import type { AbsolutePath } from '../foundation/model';
import type { LaneQuery, LaneRoot, LaneSearchResult } from './model';

/** 検索結果 preview の UTF-16 code unit 上限 */
const PREVIEW_CODE_UNIT_LIMIT = 1000;

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
  '--no-config',
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
  '--no-config',
  '--files',
  '--',
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

/**
 * UTF-8 byte offset から UTF-16 offset への変換
 * @param text - UTF-8 へ符号化する行テキスト
 * @param byteOffset - 0 始まり byte offset
 * @returns 0 始まり UTF-16 offset
 */
const toUtf16Offset = (text: string, byteOffset: number): number => {
  const bytes = Buffer.from(text, 'utf8');
  if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset > bytes.length) {
    throw new Error('Malformed ripgrep match byte offset');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, byteOffset)).length;
  } catch {
    throw new Error('Malformed ripgrep match byte offset');
  }
};

/**
 * 行末改行だけを除いた match 周辺 preview の生成
 * @param text - ripgrep の行テキスト
 * @param matchOffset - 0 始まり UTF-16 match offset
 * @returns 上限内の preview
 */
const createPreview = (text: string, matchOffset: number): string => {
  const withoutLineEnding = text.replace(/\r\n$|\n$/, '');
  if (withoutLineEnding.length <= PREVIEW_CODE_UNIT_LIMIT) return withoutLineEnding;

  const halfWindow = Math.floor(PREVIEW_CODE_UNIT_LIMIT / 2);
  let start = Math.max(0, matchOffset - halfWindow);
  start = Math.min(start, withoutLineEnding.length - PREVIEW_CODE_UNIT_LIMIT);
  let end = start + PREVIEW_CODE_UNIT_LIMIT;

  // surrogate pair の中間で preview を切らないための境界補正
  if (start > 0 && /[\uDC00-\uDFFF]/.test(withoutLineEnding[start] ?? '')) start += 1;
  if (/[\uD800-\uDBFF]/.test(withoutLineEnding[end - 1] ?? '')) end -= 1;
  return withoutLineEnding.slice(start, end);
};

/**
 * ripgrep --json の一行からの content ヒット抽出
 * @param line - JSON Lines の一行
 * @param roots - 帰属判定用レーンルート列
 * @returns content ヒット、match 以外または帰属不能で undefined
 */
export const parseContentMatchLine = (
  line: string,
  roots: readonly LaneRoot[],
): LaneSearchResult | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error('Malformed ripgrep JSON output');
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Malformed ripgrep JSON event');
  }
  if (value.type !== 'match') return undefined;
  if (!isRecord(value.data)) throw new Error('Malformed ripgrep match event');

  const path = value.data.path;
  const lines = value.data.lines;
  if (
    !isRecord(path) ||
    'bytes' in path ||
    typeof path.text !== 'string' ||
    !isRecord(lines) ||
    'bytes' in lines ||
    typeof lines.text !== 'string'
  ) {
    throw new Error('Unsupported ripgrep bytes payload');
  }

  const lineNumber = value.data.line_number;
  const submatches = value.data.submatches;
  if (
    !Number.isInteger(lineNumber) ||
    (lineNumber as number) < 1 ||
    !Array.isArray(submatches) ||
    !isRecord(submatches[0]) ||
    !Number.isInteger(submatches[0].start)
  ) {
    throw new Error('Malformed ripgrep match event');
  }

  const root = attributeLane(roots, path.text);
  if (!root) return undefined;
  const utf16Offset = toUtf16Offset(lines.text, submatches[0].start as number);
  return {
    kind: 'content',
    laneId: root.laneId,
    path: path.text as AbsolutePath,
    relativePath: toRelative(root, path.text),
    line: lineNumber as number,
    column: utf16Offset + 1,
    preview: createPreview(lines.text, utf16Offset),
  };
};

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
    const result = parseContentMatchLine(line, roots);
    if (!result) continue;
    if (results.length >= limit) {
      truncated = true;
      break;
    }
    results.push(result);
  }
  return { results, truncated };
};

/**
 * ripgrep --files の一行からの file ヒット抽出
 * @param line - 出力の一行
 * @param roots - 帰属判定用レーンルート列
 * @returns file ヒット、空行または帰属不能で undefined
 */
export const parseFileLine = (
  line: string,
  roots: readonly LaneRoot[],
): LaneSearchResult | undefined => {
  if (line.length === 0) return undefined;
  const root = attributeLane(roots, line);
  if (!root) return undefined;
  return {
    kind: 'file',
    laneId: root.laneId,
    path: line as AbsolutePath,
    relativePath: toRelative(root, line),
  };
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
    const result = parseFileLine(line, roots);
    if (result) results.push(result);
  }
  return results;
};
