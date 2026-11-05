import * as nodePath from 'node:path';
import { TextDecoder } from 'node:util';
import type { AbsolutePath } from '../foundation/model';
import type { LaneQuery, LaneRoot, LaneSearchResult } from './model';

/** 検索結果 preview の UTF-16 code unit 上限 */
const PREVIEW_CODE_UNIT_LIMIT = 1000;

const isWithin = (rootPath: string, absolutePath: string): boolean =>
  absolutePath === rootPath || absolutePath.startsWith(`${rootPath}/`);

/**
 * 他ルート配下に入れ子となるルートを除いた走査起点の抽出
 * @param roots - 検索対象レーンルート列
 * @returns 重複走査を生まない走査起点パス列
 */
export const searchEntryPaths = (roots: readonly LaneRoot[]): readonly string[] => {
  const paths: string[] = [];
  for (const { rootPath } of roots) {
    if (paths.includes(rootPath)) continue;
    const nested = roots.some(
      (other) => other.rootPath !== rootPath && isWithin(other.rootPath, rootPath),
    );
    if (!nested) paths.push(rootPath);
  }
  return paths;
};

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
  ...searchEntryPaths(roots),
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
  ...searchEntryPaths(roots),
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
    if (!isWithin(root.rootPath, absolutePath)) continue;
    if (!matched || root.rootPath.length > matched.rootPath.length) matched = root;
  }
  return matched;
};

const toRelative = (root: LaneRoot, absolutePath: string): string =>
  nodePath.relative(root.rootPath, absolutePath);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

/** ripgrep の行 payload の復号結果 */
interface DecodedLine {
  /** 行の byte 列 */
  readonly bytes: Buffer;
  /** preview 用の行テキスト */
  readonly text: string;
  /** 不正 UTF-8 を置換文字で復号した payload か */
  readonly lossy: boolean;
}

/**
 * ripgrep の行 payload の復号
 * @param lines - `text` または base64 の `bytes` を持つ payload
 * @returns 復号結果、どちらも欠く payload で undefined
 */
const decodeLinePayload = (lines: Readonly<Record<string, unknown>>): DecodedLine | undefined => {
  if (typeof lines.text === 'string') {
    return { bytes: Buffer.from(lines.text, 'utf8'), text: lines.text, lossy: false };
  }
  if (typeof lines.bytes === 'string') {
    const bytes = Buffer.from(lines.bytes, 'base64');
    return { bytes, text: new TextDecoder('utf-8').decode(bytes), lossy: true };
  }
  return undefined;
};

/**
 * UTF-8 byte offset から UTF-16 offset への変換
 * @param line - 復号済みの行
 * @param byteOffset - 0 始まり byte offset
 * @returns 0 始まり UTF-16 offset
 */
const toUtf16Offset = (line: DecodedLine, byteOffset: number): number => {
  if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset > line.bytes.length) {
    throw new Error('Malformed ripgrep match byte offset');
  }
  try {
    return new TextDecoder('utf-8', { fatal: !line.lossy }).decode(
      line.bytes.subarray(0, byteOffset),
    ).length;
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
  if (!isRecord(path) || !isRecord(lines)) throw new Error('Malformed ripgrep match event');
  // UTF-8 で表せないパスは開けないため、その一致だけを除外
  if (typeof path.text !== 'string') {
    if (typeof path.bytes === 'string') return undefined;
    throw new Error('Malformed ripgrep match event');
  }
  const decodedLine = decodeLinePayload(lines);
  if (!decodedLine) throw new Error('Malformed ripgrep match event');

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
  const utf16Offset = toUtf16Offset(decodedLine, submatches[0].start as number);
  return {
    kind: 'content',
    laneId: root.laneId,
    path: path.text as AbsolutePath,
    relativePath: toRelative(root, path.text),
    line: lineNumber as number,
    column: utf16Offset + 1,
    preview: createPreview(decodedLine.text, utf16Offset),
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
