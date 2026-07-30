import type { AbsolutePath } from '../foundation/model';
import type { LaneRootAvailability } from '../lane/model';
import type { LaneRootAvailabilityPort } from './ports';

/** 利用可否検査に必要な filesystem 操作 */
export interface RootAvailabilityFileSystem {
  /**
   * path 情報の取得
   * @param path - 対象絶対パス
   * @returns directory 判定を提供する path 情報
   */
  readonly stat: (path: AbsolutePath) => { readonly isDirectory: () => boolean };
  /**
   * path の access 検査
   * @param path - 対象絶対パス
   * @param mode - access mode
   */
  readonly access: (path: AbsolutePath, mode: number) => void;
  /** read と execute を要求する access mode */
  readonly readExecuteAccessMode: number;
}

/**
 * filesystem error から利用不能状態への分類
 * @param error - filesystem 操作の失敗原因
 * @returns missing または inaccessible
 */
const unavailableFrom = (error: unknown): Exclude<LaneRootAvailability, 'available'> => {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return 'inaccessible';
  }
  const code = (error as { readonly code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'inaccessible';
};

/**
 * レーンルート利用可否 inspector の生成
 * @param fileSystem - 注入可能な filesystem 操作
 * @returns 同期検査ポート
 */
export const createLaneRootAvailabilityInspector = (
  fileSystem: RootAvailabilityFileSystem,
): LaneRootAvailabilityPort => ({
  inspect: (path) => {
    try {
      const stat = fileSystem.stat(path);
      if (!stat.isDirectory()) return 'inaccessible';
      fileSystem.access(path, fileSystem.readExecuteAccessMode);
      return 'available';
    } catch (error) {
      return unavailableFrom(error);
    }
  },
});
