import { fileURLToPath } from 'node:url';
import * as nodePath from 'node:path';
import type { AbsolutePath, UriString } from './model';

/**
 * URI から絶対パスへの変換
 * @param uri - file:// スキームの URI
 * @returns 絶対パス
 */
export const uriToAbsolutePath = (uri: UriString): AbsolutePath =>
  fileURLToPath(uri) as AbsolutePath;

/**
 * 絶対パスの親ディレクトリ
 * @param path - 対象絶対パス
 * @returns 親ディレクトリの絶対パス
 */
export const parentDirectory = (path: AbsolutePath): AbsolutePath =>
  nodePath.dirname(path) as AbsolutePath;

/**
 * 絶対パスの末尾要素名
 * @param path - 対象絶対パス
 * @returns 末尾要素名
 */
export const baseName = (path: AbsolutePath): string => nodePath.basename(path);
