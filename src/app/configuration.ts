import type { InitializationMode } from './model';

/**
 * 公開設定値を初期化方式へ変換
 * @param value - VS Code から取得した設定値
 * @returns 初期化方式。未定義値と未知値は manual
 */
export const toInitializationMode = (value: unknown): InitializationMode =>
  value === 'automatic' ? 'automatic' : 'manual';
