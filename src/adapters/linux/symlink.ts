import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import type { AbsolutePath } from '../../foundation/model';
import type { WorkspaceLinkPort } from '../../workspace/ports';

/** symlink 操作 */
export interface SymlinkOps {
  /**
   * symlink の参照先取得
   * @param linkPath - 対象 symlink 絶対パス
   * @returns 参照先絶対パス、または未作成なら undefined
   */
  readonly read: (linkPath: AbsolutePath) => AbsolutePath | undefined;
  /**
   * symlink の原子的入替
   * @param linkPath - 対象 symlink 絶対パス
   * @param targetPath - 新しい参照先絶対パス
   */
  readonly replace: (linkPath: AbsolutePath, targetPath: AbsolutePath) => void;
  /**
   * symlink の削除。未作成は成功、非 symlink または削除失敗では例外
   * @param linkPath - 対象 symlink 絶対パス
   */
  readonly clear: (linkPath: AbsolutePath) => void;
}

/**
 * unknown な例外が指定したファイルシステムエラーコードを持つか判定
 * @param error - 判定対象
 * @param code - Node.js ファイルシステムエラーコード
 * @returns 指定コードを持つ Error なら true
 */
const hasErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

/**
 * active link の親 anchor が実ディレクトリか検査
 * @param linkPath - 対象 symlink 絶対パス
 * @returns 親 anchor が存在すれば true、未作成なら false
 */
const inspectLinkParent = (linkPath: AbsolutePath): boolean => {
  const parentPath = nodePath.dirname(linkPath);
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(parentPath);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Workspace link parent is not a real directory: ${parentPath}`);
  }
  return true;
};

/**
 * 同ディレクトリ内のユニークなステージング絶対パス生成
 * @param linkPath - 対象 symlink 絶対パス
 * @returns 原子的入替で経由するステージング絶対パス
 */
const stagingPathFor = (linkPath: AbsolutePath): AbsolutePath => {
  const dir = nodePath.dirname(linkPath);
  const base = nodePath.basename(linkPath);
  return nodePath.join(dir, `${base}.tmp-${process.pid}-${Date.now()}`) as AbsolutePath;
};

/**
 * symlink 操作の生成
 * @returns symlink 操作インスタンス
 */
export const createSymlinkOps = (): SymlinkOps => ({
  read: (linkPath) => {
    if (!inspectLinkParent(linkPath)) return undefined;
    try {
      return fs.readlinkSync(linkPath) as AbsolutePath;
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return undefined;
      throw error;
    }
  },

  replace: (linkPath, targetPath) => {
    if (!inspectLinkParent(linkPath)) {
      throw new Error(`Workspace link parent does not exist: ${nodePath.dirname(linkPath)}`);
    }
    const stagingPath = stagingPathFor(linkPath);
    fs.symlinkSync(targetPath, stagingPath);
    try {
      fs.renameSync(stagingPath, linkPath);
    } catch (renameError) {
      try {
        fs.unlinkSync(stagingPath);
      } catch {
        /* ステージングパスは起動ごとに固有なので残存しても他プロセスと衝突しない */
      }
      throw renameError;
    }
  },

  clear: (linkPath) => {
    if (!inspectLinkParent(linkPath)) return;
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(linkPath);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return;
      throw error;
    }
    if (!stats.isSymbolicLink()) {
      throw new Error(`Workspace link path is not a symbolic link: ${linkPath}`);
    }

    try {
      fs.unlinkSync(linkPath);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return;
      throw error;
    }
  },
});

/**
 * 特定 linkPath への束縛 symlink ポートの生成
 * @param linkPath - 対象 symlink 絶対パス
 * @returns symlink 操作ポート
 */
export const createWorkspaceLinkAdapter = (linkPath: AbsolutePath): WorkspaceLinkPort => {
  const ops = createSymlinkOps();
  return {
    linkPath,
    readTarget: () => ops.read(linkPath),
    swap: (target) => ops.replace(linkPath, target),
    clear: () => ops.clear(linkPath),
  };
};
