import type * as vscode from 'vscode';

/** Lane Terminal プロファイル契約 */
export interface LaneTerminalProfileContract {
  /** `registerTerminalProfileProvider` に渡す識別子 */
  readonly id: string;
  /** `terminal.integrated.defaultProfile.linux` の照合先となる表示名 */
  readonly title: string;
}

/**
 * Lane Terminal プロファイル契約の package.json からの読出
 * @param extension - 拡張メタデータ
 * @returns Lane Terminal プロファイル契約
 */
export const readLaneTerminalProfile = (
  extension: vscode.Extension<unknown>,
): LaneTerminalProfileContract => {
  const profiles = extension.packageJSON?.contributes?.terminal?.profiles as
    | readonly { readonly id: string; readonly title: string }[]
    | undefined;
  const profile = profiles?.[0];
  if (!profile) {
    throw new Error('package.json contributes.terminal.profiles[0] が宣言されていません');
  }
  return { id: profile.id, title: profile.title };
};
