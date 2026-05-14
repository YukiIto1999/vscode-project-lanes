import { fileURLToPath } from 'node:url';
import type { AbsolutePath, UriString } from './model';

/**
 * URI から絶対パスへの変換
 * @param uri - file:// スキームの URI
 * @returns 絶対パス
 */
export const uriToAbsolutePath = (uri: UriString): AbsolutePath =>
  fileURLToPath(uri) as AbsolutePath;

/**
 * 子孫関係の判定
 * @param child - 判定対象パス
 * @param parent - 上位パス
 * @returns 子孫または同一なら true
 */
export const isDescendantOf = (child: AbsolutePath, parent: AbsolutePath): boolean =>
  child === parent || child.startsWith(parent + '/');
