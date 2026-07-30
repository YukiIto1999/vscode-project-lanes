import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import type { AbsolutePath } from '../../foundation/model';
import type { WorkspaceAnchor } from '../../workspace/anchor';
import type { WorkspaceLinkPort } from '../../workspace/ports';

/** symlink 操作 */
export interface SymlinkOps {
  /**
   * symlink の参照先取得
   * @param linkPath - 対象 symlink 絶対パス
   * @returns 参照先絶対パス、または未作成なら undefined
   */
  readonly read: (
    linkPath: AbsolutePath,
    requiredDirectories?: readonly AbsolutePath[],
  ) => AbsolutePath | undefined;
  /**
   * symlink の原子的入替
   * @param linkPath - 対象 symlink 絶対パス
   * @param targetPath - 新しい参照先絶対パス
   */
  readonly replace: (
    linkPath: AbsolutePath,
    targetPath: AbsolutePath,
    requiredDirectories?: readonly AbsolutePath[],
  ) => void;
  /**
   * symlink の削除。未作成は成功、非 symlink または削除失敗では例外
   * @param linkPath - 対象 symlink 絶対パス
   */
  readonly clear: (linkPath: AbsolutePath, requiredDirectories?: readonly AbsolutePath[]) => void;
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
 * active link の親階層が実ディレクトリか検査
 * @param linkPath - 対象 symlink 絶対パス
 * @param requiredDirectories - symlink として辿ってはならない親階層
 * @returns 親階層が全て存在すれば true、未作成なら false
 */
const inspectLinkParents = (
  linkPath: AbsolutePath,
  requiredDirectories: readonly AbsolutePath[] | undefined,
): boolean => {
  const directories = requiredDirectories ?? [nodePath.dirname(linkPath) as AbsolutePath];
  for (const directoryPath of directories) {
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(directoryPath);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return false;
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Workspace link parent is not a real directory: ${directoryPath}`);
    }
  }
  return true;
};

/**
 * 既存 destination が symlink または未作成であることを検査
 * @param linkPath - 対象 symlink 絶対パス
 */
const assertReplaceableLinkPath = (linkPath: AbsolutePath): void => {
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
  read: (linkPath, requiredDirectories) => {
    if (!inspectLinkParents(linkPath, requiredDirectories)) return undefined;
    try {
      const target = fs.readlinkSync(linkPath);
      return (
        nodePath.isAbsolute(target) ? target : nodePath.resolve(nodePath.dirname(linkPath), target)
      ) as AbsolutePath;
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return undefined;
      throw error;
    }
  },

  replace: (linkPath, targetPath, requiredDirectories) => {
    if (!inspectLinkParents(linkPath, requiredDirectories)) {
      throw new Error(`Workspace link parent does not exist: ${nodePath.dirname(linkPath)}`);
    }
    assertReplaceableLinkPath(linkPath);
    const stagingPath = stagingPathFor(linkPath);
    fs.symlinkSync(targetPath, stagingPath);
    try {
      fs.renameSync(stagingPath, linkPath);
    } catch (renameError) {
      try {
        fs.unlinkSync(stagingPath);
      } catch {
        /* 元の rename 失敗を cleanup 失敗で覆い隠さない */
      }
      throw renameError;
    }
  },

  clear: (linkPath, requiredDirectories) => {
    if (!inspectLinkParents(linkPath, requiredDirectories)) return;
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
 * 現 workspace の namespaced link へ束縛した symlink ポートの生成
 * @param anchor - 現 workspace の anchor
 * @returns symlink 操作ポート
 */
export const createWorkspaceLinkAdapter = (anchor: WorkspaceAnchor): WorkspaceLinkPort => {
  const ops = createSymlinkOps();
  const linkPath = anchor.activeLinkPath;
  const requiredDirectories = [anchor.rootDirectoryPath, anchor.namespaceDirectoryPath] as const;
  return {
    linkPath,
    readTarget: () => ops.read(linkPath, requiredDirectories),
    swap: (target) => ops.replace(linkPath, target, requiredDirectories),
    clear: () => ops.clear(linkPath, requiredDirectories),
  };
};

/**
 * v0.1.13 以前の共有 link を読み取り専用で参照する
 * @param anchor - 現 workspace の anchor
 * @returns 旧 link target の読取
 */
export const createLegacyWorkspaceLinkReader = (
  anchor: WorkspaceAnchor,
): Pick<WorkspaceLinkPort, 'readTarget'> => {
  const ops = createSymlinkOps();
  const requiredDirectories = [anchor.rootDirectoryPath] as const;
  return {
    readTarget: () => {
      if (!inspectLinkParents(anchor.legacyActiveLinkPath, requiredDirectories)) return undefined;

      let stats: fs.Stats;
      try {
        stats = fs.lstatSync(anchor.legacyActiveLinkPath);
      } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return undefined;
        throw error;
      }
      if (!stats.isSymbolicLink()) return undefined;

      return ops.read(anchor.legacyActiveLinkPath, requiredDirectories);
    },
  };
};
