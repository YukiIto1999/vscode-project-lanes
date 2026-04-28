import * as nodePath from 'node:path';
import type { AbsolutePath } from '../../foundation/model';

/** シェル種別 (注入対応の有無) */
export type ShellKind = 'bash' | 'zsh' | 'unsupported';

/** シェル統合の起動計画 */
export interface ShellIntegrationPlan {
  /** 検出シェル種別 */
  readonly kind: ShellKind;
  /** pty.spawn に渡す引数列 */
  readonly args: readonly string[];
  /** pty.spawn に渡す環境変数 */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * シェル絶対パスからの種別判定
 * @param shellPath - シェル絶対パス
 * @returns シェル種別
 */
export const detectShellKind = (shellPath: string): ShellKind => {
  const base = nodePath.basename(shellPath);
  if (base === 'bash') return 'bash';
  if (base === 'zsh') return 'zsh';
  return 'unsupported';
};

/**
 * シェル統合の起動計画の算出
 * @param shellPath - シェル絶対パス
 * @param baseEnv - 起点環境変数
 * @param extensionPath - 拡張ルート絶対パス
 * @returns 起動計画
 */
export const planShellIntegration = (
  shellPath: string,
  baseEnv: Readonly<Record<string, string>>,
  extensionPath: AbsolutePath,
): ShellIntegrationPlan => {
  const kind = detectShellKind(shellPath);
  const integrationDir = nodePath.join(extensionPath, 'resources', 'shell-integration');

  if (kind === 'bash') {
    const rcfile = nodePath.join(integrationDir, 'lanes-bash.sh');
    return { kind, args: ['--rcfile', rcfile], env: baseEnv };
  }

  if (kind === 'zsh') {
    const zshDir = nodePath.join(integrationDir, 'zsh');
    const origZdotDir = baseEnv.ZDOTDIR ?? baseEnv.HOME ?? '';
    const env: Record<string, string> = {
      ...baseEnv,
      LANES_ORIG_ZDOTDIR: origZdotDir,
      ZDOTDIR: zshDir,
    };
    return { kind, args: [], env };
  }

  return { kind, args: [], env: baseEnv };
};
