import * as vscode from 'vscode';

const E2E_PAYLOAD_KEY = 'PROJECT_LANES_E2E_PAYLOAD';
const E2E_RUN_KEY = 'PROJECT_LANES_E2E_RUN';

/**
 * Development E2E driver の有効状態
 * @param extensionMode - runtime の ExtensionMode
 * @param environment - process environment
 * @returns Development 実行かつ E2E driver の環境変数がある場合は true
 */
export const usesE2eDriver = (
  extensionMode: vscode.ExtensionMode,
  environment: Readonly<Record<string, string | undefined>>,
): boolean =>
  extensionMode === vscode.ExtensionMode.Development &&
  Boolean(environment[E2E_PAYLOAD_KEY]) &&
  Boolean(environment[E2E_RUN_KEY]);
