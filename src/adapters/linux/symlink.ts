import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import type { AbsolutePath } from '../../foundation/model';
import type { WorkspaceLinkPort } from '../../workspace/ports';

/** symlink 操作 */
export interface SymlinkOps {
  /**
   * symlink の参照先取得
   * @param linkPath - 対象 symlink 絶対パス
   * @returns 参照先絶対パス、または読込不可で undefined
   */
  readonly read: (linkPath: AbsolutePath) => AbsolutePath | undefined;
  /**
   * symlink の原子的入替
   * @param linkPath - 対象 symlink 絶対パス
   * @param targetPath - 新しい参照先絶対パス
   */
  readonly replace: (linkPath: AbsolutePath, targetPath: AbsolutePath) => void;
}

/**
 * 同ディレクトリ内のユニークなステージング絶対パス生成
 * @param linkPath - 対象 symlink 絶対パス
 * @returns ステージング用絶対パス
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
    try {
      return fs.readlinkSync(linkPath) as AbsolutePath;
    } catch {
      return undefined;
    }
  },

  replace: (linkPath, targetPath) => {
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
  };
};
