import * as vscode from 'vscode';
import { bootstrapRuntime } from './app/bootstrap';

export const activate = (context: vscode.ExtensionContext): void => {
  bootstrapRuntime(context);
};

export const deactivate = (): void => {};
