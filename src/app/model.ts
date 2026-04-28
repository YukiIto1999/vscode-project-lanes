import type { AbsolutePath, Disposable } from '../foundation/model';

/** 拡張機能の設定値 */
export interface ProjectLanesConfig {
  /** レーン活動インジケータの表示有無 */
  readonly showActivityIndicator: boolean;
  /** シェル絶対パス */
  readonly shellPath: AbsolutePath | undefined;
}

/** 設定読み取りポート */
export interface ConfigPort {
  /**
   * 現設定値の取得
   * @returns 現設定値
   */
  readonly read: () => ProjectLanesConfig;
  /**
   * 設定変更通知の購読
   * @param listener - 変更時に呼ばれるリスナー
   * @returns 購読解除可能な Disposable
   */
  readonly onDidChange: (listener: (config: ProjectLanesConfig) => void) => Disposable;
}
