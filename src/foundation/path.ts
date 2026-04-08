import { fileURLToPath } from 'node:url';
import type { AbsolutePath, UriString } from './model';

/** file:// URI から絶対パスへの変換（UriString は file:// スキーム前提） */
export const uriToAbsolutePath = (uri: UriString): AbsolutePath =>
  fileURLToPath(uri) as AbsolutePath;

/** cwd が指定パス配下にあるかの判定（パス区切り文字境界） */
export const isDescendantOf = (child: AbsolutePath, parent: AbsolutePath): boolean =>
  child === parent || child.startsWith(parent + '/');
