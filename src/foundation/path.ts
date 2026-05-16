import { fileURLToPath } from 'node:url';
import type { AbsolutePath, UriString } from './model';

/**
 * URI から絶対パスへの変換
 * @param uri - file:// スキームの URI
 * @returns 絶対パス
 */
export const uriToAbsolutePath = (uri: UriString): AbsolutePath =>
  fileURLToPath(uri) as AbsolutePath;
